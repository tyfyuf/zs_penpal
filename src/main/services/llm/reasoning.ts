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
 * Infer a conservative provider dialect from the endpoint/model pair. Unknown
 * providers are deliberately left at their default because guessing a private
 * request field can turn a successful request into a 400.
 */
export function inferStructuredReasoningControl(settings: Pick<ApiSettings, 'baseURL' | 'model'>): StructuredReasoningControl {
  const host = hostname(settings.baseURL)
  const model = normalized(settings.model)
  const isDeepSeek = host === 'api.deepseek.com'
    || host.endsWith('.api.deepseek.com')
    || model.includes('deepseek')
  if (isDeepSeek) return 'deepseek_thinking'

  const isQwen = host.includes('dashscope.aliyuncs.com')
    || host.includes('dashscope-intl.aliyuncs.com')
    || model.includes('qwen')
  if (isQwen) return 'qwen_enable_thinking'

  const isKimi = host === 'api.moonshot.cn'
    || host.endsWith('.moonshot.cn')
    || host.includes('moonshot.ai')
    || model.includes('kimi')
    || model.includes('moonshot')
  if (isKimi) return 'kimi_thinking'

  return 'provider_default_only'
}

export function reasoningControlLabel(control: StructuredReasoningControl): string {
  return control === 'provider_default_only' ? 'provider_default' : control
}

/**
 * Translate the semantic request to the provider-independent Responses shape.
 * Known thinking-capable providers use the Responses reasoning control; an
 * adapter may still downgrade after a provider rejects the optional field.
 */
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
