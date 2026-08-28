import type { ApiProtocol } from '@shared/types'
import OpenAI from 'openai'
import type { ChatCompletion, ChatCompletionChunk } from 'openai/resources/chat/completions/completions'
import type { Stream } from 'openai/streaming'
import type { ApiSettings } from '../api-settings'
import type { StructuredResponse, StructuredResponseUsage } from './llm.types'

export interface ChatCompletionRequestOptions {
  signal?: AbortSignal
}

export class UnsupportedApiProtocolError extends Error {
  constructor(protocol: ApiProtocol) {
    super(`API protocol "${protocol}" is not available in this build`)
    this.name = 'UnsupportedApiProtocolError'
  }
}

/**
 * Stable boundary for wire-protocol adapters. Existing services keep using
 * Chat-shaped messages, while each adapter translates the non-streaming
 * structured-generation request to its native wire format.
 */
export interface LlmAdapter {
  readonly protocol: ApiProtocol
  readonly client: OpenAI
  createChatCompletion(body: Record<string, unknown>): Promise<ChatCompletion>
  createChatCompletionStream(
    body: Record<string, unknown>,
    options?: ChatCompletionRequestOptions
  ): Promise<Stream<ChatCompletionChunk>>
  createStructuredResponse(body: Record<string, unknown>): Promise<StructuredResponse>
}

function createClient(baseURL: string, apiKey: string): OpenAI {
  return new OpenAI({ baseURL, apiKey, timeout: 180000, maxRetries: 0 })
}

function chatUsageToStructured(usage: ChatCompletion['usage']): StructuredResponseUsage | null {
  if (!usage) return null
  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens
  }
}

function normalizeChatStructuredResponse(response: ChatCompletion): StructuredResponse {
  const choice = response.choices?.[0]
  return {
    output_text: typeof choice?.message?.content === 'string' ? choice.message.content : '',
    status: choice?.finish_reason === 'length' ? 'incomplete' : 'completed',
    incomplete_details: choice?.finish_reason === 'length' ? { reason: 'max_output_tokens' } : null,
    finish_reason: choice?.finish_reason ?? null,
    usage: chatUsageToStructured(response.usage)
  }
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => {
    if (typeof part === 'string') return part
    if (!part || typeof part !== 'object') return ''
    const text = (part as { text?: unknown }).text
    return typeof text === 'string' ? text : ''
  }).join('')
}

function responseInputFromMessages(messages: unknown): unknown[] {
  if (!Array.isArray(messages)) return []
  return messages.map((message) => {
    const item = (message && typeof message === 'object') ? message as Record<string, unknown> : {}
    const role = item.role === 'assistant' || item.role === 'system' || item.role === 'developer'
      ? item.role
      : 'user'
    return {
      type: 'message',
      role,
      content: contentToText(item.content)
    }
  })
}

function responseTextFormat(responseFormat: unknown): unknown {
  if (!responseFormat || typeof responseFormat !== 'object') return undefined
  const format = responseFormat as Record<string, unknown>
  if (format.type === 'json_object') return { type: 'json_object' }
  if (format.type === 'json_schema') {
    const schema = format.json_schema
    if (!schema || typeof schema !== 'object') return undefined
    const config = schema as Record<string, unknown>
    return {
      type: 'json_schema',
      name: typeof config.name === 'string' ? config.name : 'structured_output',
      ...(typeof config.description === 'string' ? { description: config.description } : {}),
      ...(typeof config.strict === 'boolean' ? { strict: config.strict } : {}),
      schema: config.schema ?? {}
    }
  }
  return { type: 'text' }
}

function responseRequestFromChatBody(body: Record<string, unknown>): Record<string, unknown> {
  const request: Record<string, unknown> = {
    model: body.model,
    input: responseInputFromMessages(body.messages),
    stream: false
  }
  const outputTokens = body.max_completion_tokens ?? body.max_tokens
  if (typeof outputTokens === 'number') request.max_output_tokens = outputTokens
  if (typeof body.temperature === 'number') request.temperature = body.temperature
  const format = responseTextFormat(body.response_format)
  if (format) request.text = { format }
  return request
}

function extractResponseOutputText(response: Record<string, unknown>): string {
  // The SDK exposes the concatenated assistant text as output_text. Keep a
  // structural fallback for compatible gateways, but only read message items;
  // reasoning/tool items must never become the generated JSON payload.
  if (typeof response.output_text === 'string' && response.output_text.trim()) return response.output_text
  if (!Array.isArray(response.output)) return ''
  const chunks: string[] = []
  for (const item of response.output) {
    if (!item || typeof item !== 'object') continue
    const outputItem = item as Record<string, unknown>
    if (outputItem.type !== 'message') continue
    const content = outputItem.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const contentPart = part as Record<string, unknown>
      // Responses message content normally uses output_text. Accept an
      // omitted type for older compatible implementations, but skip other
      // content kinds such as refusal/input_text.
      if (typeof contentPart.type === 'string' && contentPart.type !== 'output_text') continue
      if (typeof contentPart.text === 'string') chunks.push(contentPart.text)
    }
  }
  return chunks.join('')
}

class ChatCompletionsAdapter implements LlmAdapter {
  readonly protocol = 'chat_completions' as const
  readonly client: OpenAI

  constructor(settings: ApiSettings) {
    this.client = createClient(settings.baseURL, settings.apiKey!)
  }

  async createChatCompletion(body: Record<string, unknown>): Promise<ChatCompletion> {
    return await this.client.chat.completions.create(body as never) as ChatCompletion
  }

  async createChatCompletionStream(
    body: Record<string, unknown>,
    options?: ChatCompletionRequestOptions
  ): Promise<Stream<ChatCompletionChunk>> {
    return await this.client.chat.completions.create(body as never, options as never) as unknown as Stream<ChatCompletionChunk>
  }

  async createStructuredResponse(body: Record<string, unknown>): Promise<StructuredResponse> {
    return normalizeChatStructuredResponse(await this.createChatCompletion(body))
  }
}

class ResponsesAdapter implements LlmAdapter {
  readonly protocol = 'responses' as const
  readonly client: OpenAI

  constructor(settings: ApiSettings) {
    this.client = createClient(settings.baseURL, settings.apiKey!)
  }

  async createChatCompletion(_body: Record<string, unknown>): Promise<ChatCompletion> {
    throw new UnsupportedApiProtocolError('responses')
  }

  async createChatCompletionStream(_body: Record<string, unknown>): Promise<Stream<ChatCompletionChunk>> {
    throw new UnsupportedApiProtocolError('responses')
  }

  async createStructuredResponse(body: Record<string, unknown>): Promise<StructuredResponse> {
    const response = await this.client.responses.create(responseRequestFromChatBody(body) as never) as unknown as Record<string, unknown>
    const usage = response.usage && typeof response.usage === 'object'
      ? response.usage as Record<string, unknown>
      : null
    const incomplete = response.incomplete_details && typeof response.incomplete_details === 'object'
      ? response.incomplete_details as Record<string, unknown>
      : null
    return {
      output_text: extractResponseOutputText(response),
      output: Array.isArray(response.output) ? response.output : undefined,
      status: typeof response.status === 'string' ? response.status : null,
      incomplete_details: incomplete ? { reason: typeof incomplete.reason === 'string' ? incomplete.reason : null } : null,
      usage: usage ? {
        input_tokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined,
        output_tokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined,
        total_tokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined
      } : null,
      error_message: response.error && typeof response.error === 'object'
        && typeof (response.error as Record<string, unknown>).message === 'string'
        ? (response.error as Record<string, unknown>).message as string
        : null
    }
  }
}

export function createLlmAdapter(settings: ApiSettings): LlmAdapter {
  if (!settings.apiKey) throw new Error('未配置 API Key')
  if (settings.apiProtocol === 'chat_completions') return new ChatCompletionsAdapter(settings)
  return new ResponsesAdapter(settings)
}

/** Models and other protocol-neutral endpoints continue using the SDK client. */
export function createOpenAIClient(baseURL: string, apiKey: string): OpenAI {
  return createClient(baseURL, apiKey)
}
