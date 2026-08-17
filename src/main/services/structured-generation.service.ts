import OpenAI from 'openai'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import type { ApiSettings } from './api-settings'
import { recordUsage } from './usage.service'
import { atomicWriteJson, readJson } from '../util'
import { getUserDataDir } from '../paths'
import { join } from 'path'
import { createHash } from 'crypto'
import { logStructuredGenerationAttempt } from './log.service'

export type StructuredOutputMode = 'json_schema' | 'json_object' | 'prompt_only'
type ReasoningControl = 'deepseek_thinking' | 'provider_default_only'
type OutputTokenParam = 'max_tokens' | 'max_completion_tokens'

interface ModelCapabilityProfile {
  key: string
  source: 'preset' | 'runtime-fallback'
  structuredOutput: StructuredOutputMode
  reasoningControl: ReasoningControl
  outputTokenParam: OutputTokenParam
  temperature: 'supported' | 'unsupported'
  updatedAt: string
  profileVersion: 1
}

interface CapabilityStore {
  profiles: Record<string, ModelCapabilityProfile>
}

export interface StructuredTaskOptions<T> {
  task: string
  settings: ApiSettings
  messages: ChatCompletionMessageParam[]
  compactMessages?: ChatCompletionMessageParam[]
  outputTokens: number
  compactOutputTokens: number
  parseAndValidate: (raw: string) => T | null
  jsonSchema?: Record<string, unknown>
}

export class StructuredGenerationError extends Error {
  constructor(message: string, public readonly code: 'unsupported' | 'truncated' | 'invalid' | 'empty' | 'request') {
    super(message)
    this.name = 'StructuredGenerationError'
  }
}

function capabilityPath(): string {
  return join(getUserDataDir(), 'model-capabilities.json')
}

function normalizedBaseUrl(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, '').toLowerCase()
}

function profileKey(settings: ApiSettings): string {
  return `${normalizedBaseUrl(settings.baseURL)}::${settings.model.trim().toLowerCase()}`
}

function isOfficialDeepSeekEndpoint(baseURL: string): boolean {
  try {
    const host = new URL(baseURL).hostname.toLowerCase()
    return host === 'api.deepseek.com' || host.endsWith('.api.deepseek.com')
  } catch {
    return false
  }
}

async function loadCapabilityStore(): Promise<CapabilityStore> {
  return (await readJson<CapabilityStore>(capabilityPath())) ?? { profiles: {} }
}

async function saveProfile(profile: ModelCapabilityProfile): Promise<void> {
  const store = await loadCapabilityStore()
  store.profiles[profile.key] = profile
  await atomicWriteJson(capabilityPath(), store)
}

function defaultProfile(settings: ApiSettings): ModelCapabilityProfile {
  const deepseek = isOfficialDeepSeekEndpoint(settings.baseURL)
  return {
    key: profileKey(settings),
    source: deepseek ? 'preset' : 'runtime-fallback',
    // json_object is widely implemented by OpenAI-compatible endpoints. A 400 automatically falls back.
    structuredOutput: 'json_object',
    reasoningControl: deepseek ? 'deepseek_thinking' : 'provider_default_only',
    outputTokenParam: 'max_tokens',
    temperature: 'supported',
    updatedAt: new Date().toISOString(),
    profileVersion: 1
  }
}

function makeClient(settings: ApiSettings): OpenAI {
  return new OpenAI({ baseURL: settings.baseURL, apiKey: settings.apiKey!, timeout: 180000, maxRetries: 0 })
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function isUnsupportedParameter(error: unknown): boolean {
  const text = errorText(error).toLowerCase()
  return /unsupported|unknown parameter|unrecognized|not allowed|invalid.*(parameter|field)|response_format|thinking|reasoning|temperature|max_completion_tokens/.test(text)
}

function isTransportError(error: unknown): boolean {
  const status = (error as { status?: number })?.status
  return status === 408 || status === 429 || (typeof status === 'number' && status >= 500)
}

function compactReason(reason: string): string {
  return reason.replace(/\s+/g, ' ').slice(0, 300)
}

function endpointFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function buildRequest(
  settings: ApiSettings,
  profile: ModelCapabilityProfile,
  messages: ChatCompletionMessageParam[],
  outputTokens: number,
  mode: StructuredOutputMode,
  jsonSchema?: Record<string, unknown>
): Record<string, unknown> {
  const request: Record<string, unknown> = {
    model: settings.model,
    messages,
    [profile.outputTokenParam]: outputTokens
  }
  if (profile.temperature === 'supported') request.temperature = 0.2
  if (mode === 'json_object') request.response_format = { type: 'json_object' }
  if (mode === 'json_schema' && jsonSchema) {
    request.response_format = {
      type: 'json_schema',
      json_schema: { name: 'structured_output', strict: true, schema: jsonSchema }
    }
  }
  // Only the verified official endpoint receives a provider-private field.
  if (profile.reasoningControl === 'deepseek_thinking') request.thinking = { type: 'disabled' }
  return request
}

async function runAttempt<T>(
  client: OpenAI,
  options: StructuredTaskOptions<T>,
  profile: ModelCapabilityProfile,
  attempt: number,
  mode: StructuredOutputMode,
  compact: boolean
): Promise<T> {
  const started = Date.now()
  try {
    const res = await client.chat.completions.create(
      buildRequest(
        options.settings,
        profile,
        compact && options.compactMessages ? options.compactMessages : options.messages,
        compact ? options.compactOutputTokens : options.outputTokens,
        mode,
        options.jsonSchema
      ) as never
    )
    if (res.usage) await recordUsage(res.usage, 'summary')
    const choice = res.choices[0]
    const raw = choice?.message?.content ?? ''
    if (choice?.finish_reason === 'length') {
      throw new StructuredGenerationError('模型输出被截断', 'truncated')
    }
    if (!raw.trim()) throw new StructuredGenerationError('模型没有返回可用内容', 'empty')
    const value = options.parseAndValidate(raw)
    if (!value) throw new StructuredGenerationError('模型返回内容未通过结构或语义校验', 'invalid')
    logStructuredGenerationAttempt({
      task: options.task,
      endpointKey: endpointFingerprint(profile.key),
      attempt,
      mode,
      compact,
      outcome: 'success',
      durationMs: Date.now() - started,
      finishReason: choice?.finish_reason ?? null
    })
    return value
  } catch (error) {
    logStructuredGenerationAttempt({
      task: options.task,
      endpointKey: endpointFingerprint(profile.key),
      attempt,
      mode,
      compact,
      outcome: 'failure',
      durationMs: Date.now() - started,
      error: compactReason(errorText(error))
    })
    throw error
  }
}

/**
 * Provider-neutral structured generation. It never assumes an OpenAI-compatible
 * gateway supports every optional field: JSON mode, provider-private reasoning
 * control and token parameter choices can each be downgraded independently.
 */
export async function executeStructuredTask<T>(options: StructuredTaskOptions<T>): Promise<T> {
  if (!options.settings.apiKey) throw new StructuredGenerationError('未配置 API Key', 'request')
  const store = await loadCapabilityStore()
  let profile = store.profiles[profileKey(options.settings)] ?? defaultProfile(options.settings)
  const client = makeClient(options.settings)
  const primaryMode = profile.structuredOutput === 'json_schema' && !options.jsonSchema ? 'json_object' : profile.structuredOutput
  const attempts: Array<{ mode: StructuredOutputMode; compact: boolean }> = [
    { mode: primaryMode, compact: false },
    { mode: primaryMode === 'prompt_only' ? 'prompt_only' : 'prompt_only', compact: false },
    { mode: 'prompt_only', compact: true }
  ]
  let lastError: unknown
  for (let index = 0; index < attempts.length; index++) {
    const current = attempts[index]
    try {
      const value = await runAttempt(client, options, profile, index + 1, current.mode, current.compact)
      if (profile.structuredOutput !== current.mode && current.mode === 'prompt_only') {
        profile = { ...profile, structuredOutput: 'prompt_only', source: 'runtime-fallback', updatedAt: new Date().toISOString() }
        await saveProfile(profile)
      }
      return value
    } catch (error) {
      lastError = error
      if (isUnsupportedParameter(error)) {
        // Cache only explicit capability rejections. Classify the rejected field so a
        // gateway rejecting response_format does not accidentally disable DeepSeek thinking.
        const text = errorText(error).toLowerCase()
        if (/(thinking|reasoning)/.test(text) && profile.reasoningControl === 'deepseek_thinking') {
          profile = { ...profile, reasoningControl: 'provider_default_only', source: 'runtime-fallback', updatedAt: new Date().toISOString() }
        } else if (/(response_format|json_schema|json object)/.test(text)) {
          profile = { ...profile, structuredOutput: 'prompt_only', source: 'runtime-fallback', updatedAt: new Date().toISOString() }
        } else if (/temperature/.test(text) && profile.temperature === 'supported') {
          profile = { ...profile, temperature: 'unsupported', source: 'runtime-fallback', updatedAt: new Date().toISOString() }
        } else if (/max_completion_tokens/.test(text) && profile.outputTokenParam === 'max_completion_tokens') {
          profile = { ...profile, outputTokenParam: 'max_tokens', source: 'runtime-fallback', updatedAt: new Date().toISOString() }
        } else if (/max_tokens/.test(text) && profile.outputTokenParam === 'max_tokens') {
          profile = { ...profile, outputTokenParam: 'max_completion_tokens', source: 'runtime-fallback', updatedAt: new Date().toISOString() }
        } else {
          profile = { ...profile, structuredOutput: 'prompt_only', source: 'runtime-fallback', updatedAt: new Date().toISOString() }
        }
        await saveProfile(profile)
        // Retry immediately with the revised profile; do not spend a semantic retry on a 400.
        attempts.splice(index + 1, 0, { mode: profile.structuredOutput, compact: false })
      } else if (isTransportError(error) && index === 0) {
        await new Promise((resolve) => setTimeout(resolve, 600))
      }
    }
  }
  if (lastError instanceof StructuredGenerationError) throw lastError
  throw new StructuredGenerationError(`结构化生成请求失败：${compactReason(errorText(lastError))}`, 'request')
}
