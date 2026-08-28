import type { ApiProtocol } from '@shared/types'
import OpenAI from 'openai'
import type { ChatCompletion, ChatCompletionChunk } from 'openai/resources/chat/completions/completions'
import { Stream } from 'openai/streaming'
import type { ResponseStreamEvent } from 'openai/resources/responses/responses'
import type { ApiSettings } from '../api-settings'
import type { StructuredResponse, StructuredResponseUsage } from './llm.types'
import {
  chatReasoningFields,
  isReasoningControl,
  responsesReasoningFields,
  STRUCTURED_REASONING_CONTROL_FIELD,
  type StructuredReasoningControl
} from './reasoning'

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
  const input: unknown[] = []
  for (const message of messages) {
    const item = (message && typeof message === 'object') ? message as Record<string, unknown> : {}
    const role = item.role === 'assistant' || item.role === 'system' || item.role === 'developer'
      ? item.role
      : item.role === 'tool' ? 'tool' : 'user'

    if (role === 'tool') {
      const callId = typeof item.tool_call_id === 'string' ? item.tool_call_id : ''
      if (callId) input.push({ type: 'function_call_output', call_id: callId, output: contentToText(item.content) })
      continue
    }

    const toolCalls = Array.isArray(item.tool_calls) ? item.tool_calls : []
    const text = contentToText(item.content)
    if (text || toolCalls.length === 0) {
      input.push({ type: 'message', role, content: text })
    }
    for (const toolCall of toolCalls) {
      if (!toolCall || typeof toolCall !== 'object') continue
      const call = toolCall as Record<string, unknown>
      const fn = call.function && typeof call.function === 'object' ? call.function as Record<string, unknown> : {}
      const callId = typeof call.id === 'string' ? call.id : ''
      const name = typeof fn.name === 'string' ? fn.name : ''
      if (callId && name) {
        input.push({
          type: 'function_call',
          call_id: callId,
          name,
          arguments: typeof fn.arguments === 'string' ? fn.arguments : ''
        })
      }
    }
  }
  return input
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

function structuredReasoningControl(body: Record<string, unknown>): StructuredReasoningControl {
  const value = body[STRUCTURED_REASONING_CONTROL_FIELD]
  return isReasoningControl(value) ? value : 'provider_default_only'
}

function chatRequestFromBody(body: Record<string, unknown>): Record<string, unknown> {
  const request = { ...body }
  delete request[STRUCTURED_REASONING_CONTROL_FIELD]
  const control = structuredReasoningControl(body)
  Object.assign(request, chatReasoningFields(control))
  return request
}

function responseToolsFromChatTools(tools: unknown): unknown[] | undefined {
  if (!Array.isArray(tools)) return undefined
  const converted = tools.flatMap((tool) => {
    if (!tool || typeof tool !== 'object') return []
    const item = tool as Record<string, unknown>
    if (item.type !== 'function' || !item.function || typeof item.function !== 'object') return []
    const fn = item.function as Record<string, unknown>
    if (typeof fn.name !== 'string' || !fn.name) return []
    return [{
      type: 'function',
      name: fn.name,
      ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
      ...(fn.parameters && typeof fn.parameters === 'object' ? { parameters: fn.parameters } : {}),
      ...(typeof fn.strict === 'boolean' ? { strict: fn.strict } : {})
    }]
  })
  return converted.length > 0 ? converted : undefined
}

function responseToolChoiceFromChatChoice(choice: unknown): unknown {
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice
  if (!choice || typeof choice !== 'object') return undefined
  const item = choice as Record<string, unknown>
  if (item.type !== 'function' || !item.function || typeof item.function !== 'object') return undefined
  const fn = item.function as Record<string, unknown>
  return typeof fn.name === 'string' && fn.name ? { type: 'function', name: fn.name } : undefined
}

function responseRequestFromChatBody(body: Record<string, unknown>, stream = false): Record<string, unknown> {
  // Responses does not emit a visible reasoning summary unless it is
  // explicitly requested. Ordinary chat requests must keep the provider's
  // default reasoning effort, so request only the summary here. Structured
  // generation carries the private control field and must retain its existing
  // provider-specific reasoning policy instead.
  const isStructuredRequest = Object.prototype.hasOwnProperty.call(body, STRUCTURED_REASONING_CONTROL_FIELD)
  const reasoning = isStructuredRequest
    ? responsesReasoningFields(structuredReasoningControl(body))
    : { reasoning: { summary: 'auto' } }
  const request: Record<string, unknown> = {
    model: body.model,
    input: responseInputFromMessages(body.messages),
    stream,
    ...reasoning
  }
  const outputTokens = body.max_completion_tokens ?? body.max_tokens
  if (typeof outputTokens === 'number') request.max_output_tokens = outputTokens
  if (typeof body.temperature === 'number') request.temperature = body.temperature
  const format = responseTextFormat(body.response_format)
  if (format) request.text = { format }
  const tools = responseToolsFromChatTools(body.tools)
  if (tools) request.tools = tools
  const toolChoice = responseToolChoiceFromChatChoice(body.tool_choice)
  if (toolChoice) request.tool_choice = toolChoice
  return request
}

function responseUsageToChatUsage(usage: unknown): ChatCompletion['usage'] | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const value = usage as Record<string, unknown>
  const prompt = typeof value.input_tokens === 'number' ? value.input_tokens : undefined
  const completion = typeof value.output_tokens === 'number' ? value.output_tokens : undefined
  const total = typeof value.total_tokens === 'number'
    ? value.total_tokens
    : prompt !== undefined && completion !== undefined ? prompt + completion : undefined
  if (prompt === undefined && completion === undefined && total === undefined) return undefined
  return {
    prompt_tokens: prompt ?? 0,
    completion_tokens: completion ?? 0,
    total_tokens: total ?? 0
  }
}

function responseOutputFunctionCalls(output: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(output)) return []
  return output.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const value = item as Record<string, unknown>
    if (value.type !== 'function_call') return []
    return [{
      id: typeof value.call_id === 'string' ? value.call_id : typeof value.id === 'string' ? value.id : undefined,
      type: 'function',
      function: {
        name: typeof value.name === 'string' ? value.name : '',
        arguments: typeof value.arguments === 'string' ? value.arguments : ''
      }
    }]
  })
}

function normalizeResponseChatCompletion(response: Record<string, unknown>, model: unknown): ChatCompletion {
  const calls = responseOutputFunctionCalls(response.output)
  const status = typeof response.status === 'string' ? response.status : ''
  const incomplete = response.incomplete_details && typeof response.incomplete_details === 'object'
    ? response.incomplete_details as Record<string, unknown>
    : undefined
  const finishReason = calls.length > 0
    ? 'tool_calls'
    : status === 'incomplete' && incomplete?.reason === 'max_output_tokens' ? 'length' : 'stop'
  return {
    id: typeof response.id === 'string' ? response.id : `resp_${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: typeof response.model === 'string' ? response.model : typeof model === 'string' ? model : '',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: extractResponseOutputText(response) || null,
        ...(calls.length > 0 ? { tool_calls: calls } : {})
      },
      finish_reason: finishReason
    }],
    ...(responseUsageToChatUsage(response.usage) ? { usage: responseUsageToChatUsage(response.usage) } : {})
  } as ChatCompletion
}

function responseStreamToChatStream(
  source: Stream<ResponseStreamEvent>,
  model: unknown,
  controller: AbortController
): Stream<ChatCompletionChunk> {
  async function* iterator(): AsyncGenerator<ChatCompletionChunk> {
    const id = `resp_stream_${Date.now()}`
    const created = Math.floor(Date.now() / 1000)
    const callIdsByItemId = new Map<string, string>()
    // Some gateways emit only the final `.done` reasoning event, while the
    // native Responses stream emits deltas followed by that same full text.
    // Remember which reasoning parts already produced deltas so a fallback
    // `.done` event cannot duplicate the visible summary.
    const reasoningPartsWithDelta = new Set<string>()

    const reasoningPartKey = (event: Record<string, unknown>): string => {
      const itemId = typeof event.item_id === 'string' ? event.item_id : ''
      const outputIndex = typeof event.output_index === 'number' ? event.output_index : 0
      const partIndex = typeof event.summary_index === 'number'
        ? event.summary_index
        : typeof event.content_index === 'number' ? event.content_index : 0
      return `${itemId}:${outputIndex}:${partIndex}`
    }

    const reasoningText = (event: Record<string, unknown>): string | undefined => {
      if (typeof event.delta === 'string') return event.delta
      if (typeof event.text === 'string') return event.text
      if (event.part && typeof event.part === 'object' && typeof (event.part as Record<string, unknown>).text === 'string') {
        return (event.part as Record<string, unknown>).text as string
      }
      if (event.delta && typeof event.delta === 'object' && typeof (event.delta as Record<string, unknown>).text === 'string') {
        return (event.delta as Record<string, unknown>).text as string
      }
      return undefined
    }

    for await (const rawEvent of source) {
      const event = rawEvent as unknown as Record<string, unknown>
      const type = typeof event.type === 'string' ? event.type : ''
      const response = event.response && typeof event.response === 'object'
        ? event.response as Record<string, unknown>
        : undefined
      const delta: Record<string, unknown> = {}
      let finishReason: string | null = null
      let usage: ChatCompletion['usage'] | undefined

      if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
        delta.content = event.delta
      } else if (type.includes('reasoning') && type.endsWith('.delta')) {
        const text = reasoningText(event)
        if (text) {
          reasoningPartsWithDelta.add(reasoningPartKey(event))
          delta.reasoning_content = text
        }
      } else if (type.includes('reasoning') && type.endsWith('.done')) {
        const text = reasoningText(event)
        if (text && !reasoningPartsWithDelta.has(reasoningPartKey(event))) {
          delta.reasoning_content = text
        }
      } else if (type === 'response.output_item.added' && event.item && typeof event.item === 'object') {
        const item = event.item as Record<string, unknown>
        if (item.type === 'function_call') {
          const itemId = typeof item.id === 'string' ? item.id : ''
          const callId = typeof item.call_id === 'string' ? item.call_id : itemId
          if (itemId && callId) callIdsByItemId.set(itemId, callId)
          delta.tool_calls = [{
            index: typeof event.output_index === 'number' ? event.output_index : 0,
            id: callId || undefined,
            type: 'function',
            function: {
              name: typeof item.name === 'string' ? item.name : '',
              arguments: typeof item.arguments === 'string' ? item.arguments : ''
            }
          }]
        }
      } else if (type === 'response.function_call_arguments.delta' && typeof event.delta === 'string') {
        delta.tool_calls = [{
          index: typeof event.output_index === 'number' ? event.output_index : 0,
          id: typeof event.item_id === 'string' ? callIdsByItemId.get(event.item_id) ?? event.item_id : undefined,
          type: 'function',
          function: { arguments: event.delta }
        }]
      } else if (type === 'response.completed') {
        finishReason = 'stop'
        usage = responseUsageToChatUsage(response?.usage)
      } else if (type === 'response.incomplete') {
        const incomplete = response?.incomplete_details
        finishReason = incomplete && typeof incomplete === 'object' && (incomplete as Record<string, unknown>).reason === 'max_output_tokens'
          ? 'length'
          : 'stop'
        usage = responseUsageToChatUsage(response?.usage)
      } else if (type === 'response.failed') {
        const error = response?.error && typeof response.error === 'object' ? response.error as Record<string, unknown> : undefined
        throw new Error(typeof error?.message === 'string' ? error.message : 'Responses API request failed')
      }

      if (Object.keys(delta).length === 0 && finishReason === null && !usage) continue
      yield {
        id,
        object: 'chat.completion.chunk',
        created,
        model: typeof model === 'string' ? model : '',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...(usage ? { usage } : {})
      } as ChatCompletionChunk
    }
  }
  return new Stream(iterator, controller)
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
    return await this.client.chat.completions.create(chatRequestFromBody(body) as never) as ChatCompletion
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

  async createChatCompletion(body: Record<string, unknown>): Promise<ChatCompletion> {
    const response = await this.client.responses.create(responseRequestFromChatBody(body) as never) as never as Record<string, unknown>
    return normalizeResponseChatCompletion(response, body.model)
  }

  async createChatCompletionStream(
    body: Record<string, unknown>,
    options?: ChatCompletionRequestOptions
  ): Promise<Stream<ChatCompletionChunk>> {
    const controller = new AbortController()
    if (options?.signal) {
      if (options.signal.aborted) controller.abort()
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    const source = await this.client.responses.create(
      responseRequestFromChatBody(body, true) as never,
      { signal: controller.signal }
    ) as never as Stream<ResponseStreamEvent>
    return responseStreamToChatStream(source, body.model, controller)
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
