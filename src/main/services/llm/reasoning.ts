import type { ApiSettings } from '../api-settings'

/**
 * Provider-specific wire dialects used only by structured generation.
 * `provider_default_only` is the safe fallback for unknown models.
 */
export type StructuredReasoningControl =
  | 'deepseek_thinking'
  | 'qwen_enable_thinking'
  | 'kimi_thinking'
  | 'provider_default_only'

/** A conservative provider grouping inferred only from endpoint/model metadata. */
export type ProviderFamily =
  | 'deepseek'
  | 'qwen'
  | 'kimi'
  | 'openrouter'
  | 'openai'
  | 'generic_openai_compatible'

/** Whether assistant reasoning must be replayed in a subsequent request. */
export type ReasoningReplayPolicy = 'never' | 'when_present'

/** Private request metadata consumed by an LLM adapter and never sent on wire. */
export const STRUCTURED_REASONING_CONTROL_FIELD = '__structured_reasoning_control'

function normalized(value: string): string {
  return value.trim().toLowerCase()
}

function hostname(baseURL: string): string {
  try {
    return new URL(baseURL).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * Infer only stable, high-confidence provider families. The result governs
 * compatibility behavior, never user-visible model selection.
 */
export function inferProviderFamily(settings: Pick<ApiSettings, 'baseURL' | 'model'>): ProviderFamily {
  const host = hostname(settings.baseURL)
  const model = normalized(settings.model)
  if (host === 'api.deepseek.com' || host.endsWith('.api.deepseek.com') || model.includes('deepseek')) {
    return 'deepseek'
  }
  if (host.includes('dashscope.aliyuncs.com') || host.includes('dashscope-intl.aliyuncs.com') || model.includes('qwen')) {
    return 'qwen'
  }
  if (
    host === 'api.moonshot.cn'
    || host.endsWith('.moonshot.cn')
    || host.includes('moonshot.ai')
    || model.includes('kimi')
    || model.includes('moonshot')
  ) {
    return 'kimi'
  }
  if (host.includes('openrouter.ai')) return 'openrouter'
  if (host === 'api.openai.com' || host.endsWith('.api.openai.com')) return 'openai'
  return 'generic_openai_compatible'
}

/**
 * A replay requirement is a provider protocol rule, not a general thinking
 * feature. DeepSeek is the only provider confirmed by our integration tests to
 * require it by default; endpoint/model-specific runtime learning can extend
 * this policy for other providers.
 */
export function defaultReasoningReplayPolicy(provider: ProviderFamily): ReasoningReplayPolicy {
  return provider === 'deepseek' ? 'when_present' : 'never'
}

/**
 * Infer a conservative provider dialect from the endpoint/model pair. Unknown
 * providers are deliberately left at their default because guessing a private
 * request field can turn a successful request into a 400.
 */
export function inferStructuredReasoningControl(settings: Pick<ApiSettings, 'baseURL' | 'model'>): StructuredReasoningControl {
  switch (inferProviderFamily(settings)) {
    case 'deepseek': return 'deepseek_thinking'
    case 'qwen': return 'qwen_enable_thinking'
    case 'kimi': return 'kimi_thinking'
    default: return 'provider_default_only'
  }
}

export function reasoningControlLabel(control: StructuredReasoningControl): string {
  return control === 'provider_default_only' ? 'provider_default' : control
}

/**
 * Detect only the explicit server-side contract that says a prior assistant
 * reasoning payload must be sent back. Do not learn from generic 400s, timeouts
 * or output failures.
 */
export function isReasoningReplayRequiredError(error: unknown): boolean {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : undefined
  const nested = value?.error && typeof value.error === 'object' ? value.error as Record<string, unknown> : undefined
  const text = [
    error instanceof Error ? error.message : undefined,
    value?.message,
    nested?.message,
    value?.code,
    nested?.code
  ].filter((part): part is string => typeof part === 'string').join(' ').toLowerCase()
  if (!/reasoning[_ ]content|reasoning content/.test(text)) return false
  return /must be passed back|pass(?:ed)? back|must .*include|required .*subsequent|required .*follow(?:ing|up)|must .*provide/.test(text)
}

/** Translate the semantic request to the provider-independent Responses shape. */
export function responsesReasoningFields(control: StructuredReasoningControl): Record<string, unknown> {
  if (control === 'provider_default_only') return {}
  return { reasoning: { effort: 'none' } }
}

/** Translate the semantic request to Chat Completions provider extensions. */
export function chatReasoningFields(control: StructuredReasoningControl): Record<string, unknown> {
  switch (control) {
    case 'deepseek_thinking':
    case 'kimi_thinking':
      return { thinking: { type: 'disabled' } }
    case 'qwen_enable_thinking':
      return { enable_thinking: false }
    default:
      return {}
  }
}

export function isReasoningControl(value: unknown): value is StructuredReasoningControl {
  return value === 'deepseek_thinking'
    || value === 'qwen_enable_thinking'
    || value === 'kimi_thinking'
    || value === 'provider_default_only'
}
