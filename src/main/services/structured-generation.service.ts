import type { LlmAdapter } from './llm/llm-client'
import { createLlmAdapter } from './llm/llm-client'
import type { StructuredResponse } from './llm/llm.types'
import {
  reasoningControlLabel,
  STRUCTURED_REASONING_CONTROL_FIELD
} from './llm/reasoning'
import {
  defaultModelCapabilityProfile,
  loadModelCapabilityStore,
  modelCapabilityFingerprint,
  normalizeModelCapabilityProfile,
  updateModelCapabilityProfile,
  type ModelCapabilityProfile,
  type StructuredOutputMode
} from './llm/model-capabilities'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import type { ApiSettings } from './api-settings'
import { recordUsage } from './usage.service'
import { logStructuredGenerationAttempt } from './log.service'
import { noteSummaryRateLimit, noteSummaryRequestSuccess } from './summary-task-scheduler'

export type { StructuredOutputMode } from './llm/model-capabilities'
export type StructuredRetryPolicy = 'compact' | 'split-required'


export interface StructuredTaskOptions<T> {
  task: string
  settings: ApiSettings
  messages: ChatCompletionMessageParam[]
  compactMessages?: ChatCompletionMessageParam[]
  outputTokens: number
  compactOutputTokens: number
  parseAndValidate: (raw: string) => T | null
  jsonSchema?: Record<string, unknown>
  /** Override the model's normal structured-output mode for small specialized tasks. */
  outputMode?: StructuredOutputMode
  /** Limit total attempts for tasks where retries must stay strictly bounded. */
  maxAttempts?: number
  /** split-required reports truncation and timeout to the caller instead of hiding them behind a compact retry. */
  retryPolicy?: StructuredRetryPolicy
}

export class StructuredGenerationError extends Error {
  constructor(message: string, public readonly code: 'unsupported' | 'truncated' | 'invalid' | 'empty' | 'timeout' | 'request') {
    super(message)
    this.name = 'StructuredGenerationError'
  }
}

function makeClient(settings: ApiSettings): LlmAdapter {
  return createLlmAdapter(settings)
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function statusOf(error: unknown): number | undefined {
  return (error as { status?: number })?.status
}

function isUnsupportedParameter(error: unknown): boolean {
  const text = errorText(error).toLowerCase()
  return /unsupported|unknown parameter|unrecognized|not allowed|invalid.*(parameter|field)|response_format|thinking|reasoning|temperature|max_completion_tokens/.test(text)
}

function isTransportError(error: unknown): boolean {
  const status = statusOf(error)
  return status === 408 || status === 429 || (typeof status === 'number' && status >= 500)
}

function isTimeoutError(error: unknown): boolean {
  const name = String((error as { name?: unknown })?.name ?? '').toLowerCase()
  const text = errorText(error).toLowerCase()
  return statusOf(error) === 408 || name.includes('timeout') || /request timed out|timed out|timeout|etimedout/.test(text)
}

function isContextLimitError(error: unknown): boolean {
  const text = errorText(error).toLowerCase()
  return /context (?:length|window)|maximum context|too many tokens|prompt (?:is )?too long|input (?:is )?too long|request too large/.test(text)
}

function compactReason(reason: string): string {
  return reason.replace(/\s+/g, ' ').slice(0, 300)
}

function usageForRecord(response: StructuredResponse): {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
} | undefined {
  const usage = response.usage
  if (!usage) return undefined
  if (typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') return undefined
  const totalTokens = typeof usage.total_tokens === 'number'
    ? usage.total_tokens
    : usage.input_tokens + usage.output_tokens
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: totalTokens
  }
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
  // The adapter translates this semantic control into the provider/protocol
  // specific wire field. It is intentionally private and never sent verbatim.
  request[STRUCTURED_REASONING_CONTROL_FIELD] = profile.reasoningControl
  return request
}

async function runAttempt<T>(
  client: LlmAdapter,
  options: StructuredTaskOptions<T>,
  profile: ModelCapabilityProfile,
  attempt: number,
  mode: StructuredOutputMode,
  compact: boolean
): Promise<T> {
  const started = Date.now()
  try {
    const res = await client.createStructuredResponse(
      buildRequest(
        options.settings,
        profile,
        compact && options.compactMessages ? options.compactMessages : options.messages,
        compact ? options.compactOutputTokens : options.outputTokens,
        mode,
        options.jsonSchema
      ) as never
    )
    noteSummaryRequestSuccess()
    const usage = usageForRecord(res)
    if (usage) await recordUsage(usage, 'summary')
    const status = res.status?.toLowerCase()
    const incompleteReason = res.incomplete_details?.reason?.toLowerCase()
    const providerError = res.error_message?.trim()
    if (res.finish_reason === 'length' || (status === 'incomplete' && (!incompleteReason || incompleteReason === 'max_output_tokens'))) {
      throw new StructuredGenerationError('模型输出被截断', 'truncated')
    }
    if (status === 'failed' || status === 'cancelled') {
      throw new StructuredGenerationError(`Responses API 请求未完成：${status}${incompleteReason ? `（${incompleteReason}）` : ''}${providerError ? `：${providerError}` : ''}`, 'request')
    }
    const raw = res.output_text
    if (!raw.trim()) throw new StructuredGenerationError('模型没有返回可用内容', 'empty')
    const value = options.parseAndValidate(raw)
    if (!value) throw new StructuredGenerationError('模型返回内容未通过结构或语义校验', 'invalid')
    logStructuredGenerationAttempt({
      task: options.task,
      protocol: options.settings.apiProtocol,
      reasoningControl: reasoningControlLabel(profile.reasoningControl),
      providerFamily: profile.providerFamily,
      reasoningReplay: profile.reasoningReplay,
      endpointKey: modelCapabilityFingerprint(profile),
      attempt,
      mode,
      compact,
      outcome: 'success',
      durationMs: Date.now() - started,
      finishReason: res.finish_reason ?? res.incomplete_details?.reason ?? res.status ?? null
    })
    return value
  } catch (error) {
    if (statusOf(error) === 429) noteSummaryRateLimit()
    logStructuredGenerationAttempt({
      task: options.task,
      protocol: options.settings.apiProtocol,
      reasoningControl: reasoningControlLabel(profile.reasoningControl),
      providerFamily: profile.providerFamily,
      reasoningReplay: profile.reasoningReplay,
      endpointKey: modelCapabilityFingerprint(profile),
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

function downgradedProfile(profile: ModelCapabilityProfile, error: unknown): ModelCapabilityProfile {
  const text = errorText(error).toLowerCase()
  const common = { source: 'runtime-fallback' as const, updatedAt: new Date().toISOString() }
  if (/(thinking|reasoning)/.test(text)) {
    return profile.reasoningControl !== 'provider_default_only'
      ? { ...profile, ...common, reasoningControl: 'provider_default_only' }
      : profile
  }
  if (/(response_format|json_schema|json object)/.test(text)) {
    return profile.structuredOutput !== 'prompt_only'
      ? { ...profile, ...common, structuredOutput: 'prompt_only' }
      : profile
  }
  if (/temperature/.test(text)) {
    return profile.temperature === 'supported'
      ? { ...profile, ...common, temperature: 'unsupported' }
      : profile
  }
  if (/max_completion_tokens/.test(text)) {
    return profile.outputTokenParam === 'max_completion_tokens'
      ? { ...profile, ...common, outputTokenParam: 'max_tokens' }
      : profile
  }
  if (/max_tokens/.test(text)) {
    return profile.outputTokenParam === 'max_tokens'
      ? { ...profile, ...common, outputTokenParam: 'max_completion_tokens' }
      : profile
  }
  return { ...profile, ...common, structuredOutput: 'prompt_only' }
}

/**
 * Provider-neutral structured generation. It never assumes an OpenAI-compatible
 * gateway supports every optional field: JSON mode, provider-private reasoning
 * control and token parameter choices can each be downgraded independently.
 */
export async function executeStructuredTask<T>(options: StructuredTaskOptions<T>): Promise<T> {
  if (!options.settings.apiKey) throw new StructuredGenerationError('未配置 API Key', 'request')
  const store = await loadModelCapabilityStore()
  const fallbackProfile = defaultModelCapabilityProfile(options.settings)
  let profile = normalizeModelCapabilityProfile(store.profiles[fallbackProfile.key], fallbackProfile)
  const client = makeClient(options.settings)
  const inferredMode = profile.structuredOutput === 'json_schema' && !options.jsonSchema ? 'json_object' : profile.structuredOutput
  const primaryMode = options.outputMode ?? inferredMode
  const retryPolicy = options.retryPolicy ?? 'compact'
  const attempts: Array<{ mode: StructuredOutputMode; compact: boolean }> = options.outputMode
    ? [
        { mode: options.outputMode, compact: false },
        { mode: options.outputMode, compact: true }
      ]
    : retryPolicy === 'split-required'
      ? [
          { mode: primaryMode, compact: false },
          { mode: 'prompt_only', compact: false }
        ]
      : [
          { mode: primaryMode, compact: false },
          { mode: 'prompt_only', compact: false },
          { mode: 'prompt_only', compact: true }
        ]
  let lastError: unknown
  let capabilityFallbacks = 0
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? attempts.length))
  for (let index = 0; index < attempts.length && index < maxAttempts; index++) {
    const current = attempts[index]
    try {
      const value = await runAttempt(client, options, profile, index + 1, current.mode, current.compact)
      if (!options.outputMode && profile.structuredOutput !== current.mode && current.mode === 'prompt_only') {
        profile = await updateModelCapabilityProfile(profile, (latest) => ({
          ...latest,
          structuredOutput: 'prompt_only',
          source: 'runtime-fallback',
          updatedAt: new Date().toISOString()
        }))
      }
      return value
    } catch (error) {
      lastError = error
      if (retryPolicy === 'split-required') {
        if (error instanceof StructuredGenerationError && ['truncated', 'timeout'].includes(error.code)) throw error
        if (isTimeoutError(error)) {
          throw new StructuredGenerationError(`Structured generation request timed out: ${compactReason(errorText(error))}`, 'timeout')
        }
        if (isContextLimitError(error)) {
          throw new StructuredGenerationError(`模型上下文不足：${compactReason(errorText(error))}`, 'truncated')
        }
      }
      if (isUnsupportedParameter(error) && capabilityFallbacks < 4) {
        profile = await updateModelCapabilityProfile(profile, (latest) => downgradedProfile(latest, error))
        capabilityFallbacks++
        // Retry immediately with revised capabilities; this is not a semantic compact retry.
        attempts.splice(index + 1, 0, { mode: options.outputMode ?? profile.structuredOutput, compact: false })
      } else if (isTransportError(error) && index === 0) {
        await new Promise((resolve) => setTimeout(resolve, 600))
      }
    }
  }
  if (lastError instanceof StructuredGenerationError) throw lastError
  if (isTimeoutError(lastError)) {
    throw new StructuredGenerationError(`Structured generation request timed out: ${compactReason(errorText(lastError))}`, 'timeout')
  }
  throw new StructuredGenerationError(`结构化生成请求失败：${compactReason(errorText(lastError))}`, 'request')

}
