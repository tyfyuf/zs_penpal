import { createHash } from 'crypto'
import { join } from 'path'
import type { ApiSettings } from '../api-settings'
import { getUserDataDir } from '../../paths'
import { atomicWriteJson, readJson } from '../../util'
import {
  defaultReasoningReplayPolicy,
  inferProviderFamily,
  inferStructuredReasoningControl,
  isReasoningControl,
  type ProviderFamily,
  type ReasoningReplayPolicy,
  type StructuredReasoningControl
} from './reasoning'

export type StructuredOutputMode = 'json_schema' | 'json_object' | 'prompt_only'
export type OutputTokenParam = 'max_tokens' | 'max_completion_tokens'

export interface ModelCapabilityProfile {
  key: string
  source: 'preset' | 'runtime-fallback'
  providerFamily: ProviderFamily
  structuredOutput: StructuredOutputMode
  reasoningControl: StructuredReasoningControl
  reasoningReplay: ReasoningReplayPolicy
  outputTokenParam: OutputTokenParam
  temperature: 'supported' | 'unsupported'
  updatedAt: string
  profileVersion: 6
}

interface CachedModelCapabilityProfile extends Omit<Partial<ModelCapabilityProfile>, 'profileVersion'> {
  profileVersion?: number
}

interface CapabilityStore {
  profiles: Record<string, CachedModelCapabilityProfile>
}

function capabilityPath(): string {
  return join(getUserDataDir(), 'model-capabilities.json')
}

function normalizedBaseUrl(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, '').toLowerCase()
}

export function modelCapabilityKey(settings: Pick<ApiSettings, 'apiProtocol' | 'baseURL' | 'model'>): string {
  return `${settings.apiProtocol}::${normalizedBaseUrl(settings.baseURL)}::${settings.model.trim().toLowerCase()}`
}

export function modelCapabilityFingerprint(profile: Pick<ModelCapabilityProfile, 'key'>): string {
  return createHash('sha256').update(profile.key).digest('hex').slice(0, 16)
}

export function defaultModelCapabilityProfile(settings: ApiSettings): ModelCapabilityProfile {
  const providerFamily = inferProviderFamily(settings)
  const reasoningControl = inferStructuredReasoningControl(settings)
  return {
    key: modelCapabilityKey(settings),
    source: reasoningControl !== 'provider_default_only' ? 'preset' : 'runtime-fallback',
    providerFamily,
    // json_object is widely implemented by OpenAI-compatible endpoints. A 400 automatically falls back.
    structuredOutput: 'json_object',
    reasoningControl,
    // Responses converts chat history to its own input format, so only Chat
    // Completions can replay the vendor-specific reasoning_content extension.
    reasoningReplay: settings.apiProtocol === 'chat_completions'
      ? defaultReasoningReplayPolicy(providerFamily)
      : 'never',
    outputTokenParam: 'max_tokens',
    // Kimi rejects temperature and Qwen's thinking mode normalizes values
    // below 0.6. Structured generation does not need to override either
    // provider's default, so omit the field for both provider families.
    temperature: providerFamily === 'kimi' || providerFamily === 'qwen' ? 'unsupported' : 'supported',
    updatedAt: new Date().toISOString(),
    profileVersion: 6
  }
}

function isStructuredOutputMode(value: unknown): value is StructuredOutputMode {
  return value === 'json_schema' || value === 'json_object' || value === 'prompt_only'
}

function isOutputTokenParam(value: unknown): value is OutputTokenParam {
  return value === 'max_tokens' || value === 'max_completion_tokens'
}

function isReasoningReplayPolicy(value: unknown): value is ReasoningReplayPolicy {
  return value === 'never' || value === 'when_present'
}


/**
 * Migrates existing capability profile records without discarding their learned
 * structured-output capability. Provider identity and replay defaults are
 * always recalculated from the active endpoint/model, then explicit runtime
 * replay learning is retained if present.
 */
export function normalizeModelCapabilityProfile(
  cached: CachedModelCapabilityProfile | undefined,
  fallback: ModelCapabilityProfile
): ModelCapabilityProfile {
  if (!cached) return fallback
  const cachedVersion = typeof cached.profileVersion === 'number' ? cached.profileVersion : 0
  const useCachedReasoningControl = cachedVersion >= 6 && isReasoningControl(cached.reasoningControl)
  return {
    ...fallback,
    key: fallback.key,
    source: cached.source === 'preset' || cached.source === 'runtime-fallback' ? cached.source : fallback.source,
    providerFamily: fallback.providerFamily,
    structuredOutput: isStructuredOutputMode(cached.structuredOutput) ? cached.structuredOutput : fallback.structuredOutput,
    reasoningControl: useCachedReasoningControl ? cached.reasoningControl as StructuredReasoningControl : fallback.reasoningControl,
    reasoningReplay: isReasoningReplayPolicy(cached.reasoningReplay) ? cached.reasoningReplay : fallback.reasoningReplay,
    outputTokenParam: isOutputTokenParam(cached.outputTokenParam) ? cached.outputTokenParam : fallback.outputTokenParam,
    temperature: fallback.providerFamily === 'kimi' || fallback.providerFamily === 'qwen'
      ? fallback.temperature
      : cached.temperature === 'supported' || cached.temperature === 'unsupported'
        ? cached.temperature
        : fallback.temperature,
    updatedAt: typeof cached.updatedAt === 'string' ? cached.updatedAt : fallback.updatedAt,
    profileVersion: 6
  }
}

export async function loadModelCapabilityStore(): Promise<CapabilityStore> {
  const stored = await readJson<CapabilityStore>(capabilityPath())
  return stored && stored.profiles && typeof stored.profiles === 'object' ? stored : { profiles: {} }
}

let capabilityWriteQueue: Promise<void> = Promise.resolve()

export async function updateModelCapabilityProfile(
  fallback: ModelCapabilityProfile,
  mutate: (current: ModelCapabilityProfile) => ModelCapabilityProfile
): Promise<ModelCapabilityProfile> {
  let saved = fallback
  const next = capabilityWriteQueue.then(async () => {
    const store = await loadModelCapabilityStore()
    saved = { ...mutate(normalizeModelCapabilityProfile(store.profiles[fallback.key], fallback)), profileVersion: 6 }
    store.profiles[saved.key] = saved
    await atomicWriteJson(capabilityPath(), store)
  })
  capabilityWriteQueue = next.catch(() => {})
  await next
  return saved
}

export async function loadModelCapabilityProfile(settings: ApiSettings): Promise<ModelCapabilityProfile> {
  const fallback = defaultModelCapabilityProfile(settings)
  const store = await loadModelCapabilityStore()
  return normalizeModelCapabilityProfile(store.profiles[fallback.key], fallback)
}

/** Persist a narrowly-scoped endpoint+model replay requirement learned from an explicit server error. */
export async function enableReasoningReplay(settings: ApiSettings): Promise<ModelCapabilityProfile> {
  const fallback = defaultModelCapabilityProfile(settings)
  return updateModelCapabilityProfile(fallback, (current) => current.reasoningReplay === 'when_present'
    ? current
    : {
        ...current,
        source: 'runtime-fallback',
        reasoningReplay: 'when_present',
        updatedAt: new Date().toISOString()
      })
}
