import type { ApiSettings } from '../api-settings'

/**
 * Provider-specific wire dialects used only by structured generation.
 * `standard_reasoning_effort_low` is the standard lowest-effort fallback for
 * providers that expose the OpenAI reasoning-effort field.
 * `provider_default_only` is the safe fallback for unknown models.
 */
export type StructuredReasoningControl =
  | 'deepseek_thinking'
  | 'qwen_enable_thinking'
  | 'kimi_k3'
  | 'kimi_k27_code'
  | 'kimi_k26'
  | 'kimi_unknown'
  | 'standard_reasoning_effort_low'
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
  const provider = inferProviderFamily(settings)
  if (provider === 'deepseek') return 'deepseek_thinking'
  if (provider === 'qwen') return 'qwen_enable_thinking'
  if (provider === 'openai') return 'standard_reasoning_effort_low'
  if (provider !== 'kimi') return 'provider_default_only'

  const model = normalized(settings.model)
  if (model.includes('kimi-k3') || model.includes('kimi_k3')) return 'kimi_k3'
  if (model.includes('kimi-k2.7-code') || model.includes('kimi_k2.7_code')) return 'kimi_k27_code'
  if (model.includes('kimi-k2.6') || model.includes('kimi_k2.6')) return 'kimi_k26'
  return 'kimi_unknown'
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
  // Provider-private Kimi/Qwen fields are documented for Chat Completions.
  // Responses uses the standard reasoning-effort shape where the provider
  // exposes a lowest-effort mode; unsupported gateways are downgraded by the
  // structured-task capability fallback.
  if (control === 'standard_reasoning_effort_low' || control === 'kimi_k3') {
    return { reasoning: { effort: 'low' } }
  }
  if (control === 'qwen_enable_thinking' || control === 'kimi_k26') {
    return { reasoning: { effort: 'low' } }
  }
  if (control === 'provider_default_only'
    || control === 'kimi_k27_code'
    || control === 'kimi_unknown') return {}
  return { reasoning: { effort: 'none' } }
}

/** Translate the semantic request to Chat Completions provider extensions. */
export function chatReasoningFields(control: StructuredReasoningControl): Record<string, unknown> {
  switch (control) {
    case 'deepseek_thinking':
    case 'kimi_k26':
      return { thinking: { type: 'disabled' } }
    case 'qwen_enable_thinking':
      return { enable_thinking: false }
    case 'standard_reasoning_effort_low':
    case 'kimi_k3':
      return { reasoning_effort: 'low' }
    case 'kimi_k27_code':
    case 'kimi_unknown':
    default:
      // Kimi K2.7-code controls thinking server-side and rejects the
      // generic thinking field. Unknown Kimi models stay conservative.
      return {}
  }
}

export function isReasoningControl(value: unknown): value is StructuredReasoningControl {
  return value === 'deepseek_thinking'
    || value === 'qwen_enable_thinking'
    || value === 'kimi_k3'
    || value === 'kimi_k27_code'
    || value === 'kimi_k26'
    || value === 'kimi_unknown'
    || value === 'standard_reasoning_effort_low'
    || value === 'provider_default_only'
}
