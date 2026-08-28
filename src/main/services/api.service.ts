import OpenAI from 'openai'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import type {
  AppConfig,
  ChatAttachment,
  ChatMessage,
  ChatMeta,
  ConnectionTestResult,
  DocRollup,
  DocSummary,
  MemoryContext,
  MemoryContextItem,
  VectorMemoryAttempt,
  VectorSearchHit,
  ProjectTree,
  StreamContextRange,
  StreamDonePayload,
  StreamRequest
} from '@shared/types'
import { EVENTS } from '@shared/ipc'
import { loadApiSettings, type ApiSettings } from './api-settings'
import { loadConfig } from './config.service'
import { estimateTokens } from './tokenizer'
import { collectApplicableKeys, computeActiveKeys, selectDefaultKeys } from '../summary-relevance'
import {
  buildChatSummaryBlock,
  buildDocSummaryBlock,
  buildResourceSummaryBlock,
  buildRollupBlock,
  buildRollupCatalogBlock,
  ensureDocSummary
} from './summary.service'
import { logToolProtocolEvent } from './log.service'
import { recordUsage } from './usage.service'
import { executeStructuredTask } from './structured-generation.service'
import { searchVectorIndex } from './vector.service'
import {
  appendMessage,
  buildSnapshot,
  getChat,
  readChatSummary,
  readDoc,
  readDocRollups,
  readDocSummary,
  readResource,
  readResourceSummary,
  readSnapshot,
  renameChat,
  replaceLastAssistantMessage
} from './file.service'
import { newId, nowIso } from '../util'
import { analyzeTextIntegrity } from './text-decoding.service'
import { broadcast } from '../window'

// ---------------------------------------------------------------------------
// OpenAI 兼容流式对话（PRD 6.5 / 8.3 / tech-stack 6.6）
// 摘要注入：按对话类型 + 用户配置注入 文档摘要 / 对话摘要 / 资源摘要
// 思维链：捕获推理模型的 reasoning_content 并推送给渲染层展示
// ---------------------------------------------------------------------------

/** 系统提示词：理性务实的回答风格 + 跟随界面语言输出 */
function buildSystemPrompt(lang: 'zh' | 'en'): string {
  if (lang === 'en') {
    return `You are the writing assistant of VibeWrite (氛围写作). Your job is to help the writer make decisions, not to replace their writing.
Rules:
1. Never modify the user's documents automatically, and never generate, replace or export finished files automatically.
2. You may provide diagnosis, rewritten text, examples and plot suggestions in the chat, in any form.
3. Your output appears only in the chat; the user decides and copies manually.
Style:
- Rational and pragmatic: lead with conclusions, give concrete and verifiable reasons, avoid fluff and pleasantries.
- Point out problems and actionable improvements directly; no empty praise.
- Stay accurate when quoting or rewriting the original text; state clearly when uncertain.
Always respond in English.`
  }
  return `你是「氛围写作（VibeWrite）」的写作助手，职责是辅助创作者决策，不替代创作者完成写作成果。
规则：
1. 你不得自动修改用户的写作文档，也不得自动生成、替换或导出成品文件。
2. 你可以在对话中给出诊断、优化文本、改写示例和后续走向建议，表达形式不限。
3. 你的输出只显示在对话区，由用户自行判断并手动复制粘贴。
风格要求：
- 理性务实：结论先行，理由具体、可验证，少用修辞与客套；
- 直接指出问题与可操作的改进点，不空泛鼓励；
- 涉及原文引用或改写时保持准确，不确定之处明确说明。
请用中文回答。`
}

interface UsageLike {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

const controllers = new Map<string, AbortController>()

export function cancelStream(requestId: string): void {
  controllers.get(requestId)?.abort()
}

const LOW_SIGNAL_SEARCH_QUERIES = new Set([
  '\u4f60\u597d', '\u55e8', '\u54c8\u55bd', '\u8c22\u8c22', '\u597d\u7684', '\u6536\u5230',
  'hi', 'hello', 'thanks', 'thankyou', 'ok', 'okay'
])

function compactSearchQuery(text: string): string {
  const query = text.trim()
  if (query.length <= 600) return query
  return `${query.slice(0, 180)}\n...\n${query.slice(-380)}`
}

function shouldAutoRetrieve(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
  return normalized.length >= 2 && !LOW_SIGNAL_SEARCH_QUERIES.has(normalized)
}

function insertIntoSystemPrefix(
  messages: ChatCompletionMessageParam[],
  additions: ChatCompletionMessageParam[]
): ChatCompletionMessageParam[] {
  if (additions.length === 0) return messages
  const firstConversationIndex = messages.findIndex((message) => message.role !== 'system')
  if (firstConversationIndex < 0) return [...messages, ...additions]
  return [
    ...messages.slice(0, firstConversationIndex),
    ...additions,
    ...messages.slice(firstConversationIndex)
  ]
}

function vectorHitBlock(hit: VectorSearchHit, lang: 'zh' | 'en', source: 'automatic' | 'tool'): string {
  const sourceLabel = source === 'tool'
    ? (lang === 'en' ? 'tool search' : '\u5de5\u5177\u68c0\u7d22')
    : (lang === 'en' ? 'automatic search' : '\u81ea\u52a8\u68c0\u7d22')
  return `${lang === 'en' ? '\u3010Project source hit' : '\u3010\u9879\u76ee\u539f\u6587\u547d\u4e2d'}\u00b7${sourceLabel}: ${hit.title} #${hit.index}\u3011\n${hit.text}`
}

async function retrieveProjectOriginals(
  projectId: string,
  query: string,
  lang: 'zh' | 'en',
  source: 'automatic' | 'tool',
  reason = '',
  topK = 5
): Promise<{
  messages: ChatCompletionMessageParam[]
  items: MemoryContextItem[]
  attempt: VectorMemoryAttempt
  hits: VectorSearchHit[]
}> {
  const normalizedQuery = compactSearchQuery(query)
  try {
    const hits = await searchVectorIndex(projectId, normalizedQuery, Math.max(1, Math.min(topK, 5)), { source })
    return {
      messages: hits.map((hit) => ({ role: 'system', content: vectorHitBlock(hit, lang, source) })),
      items: hits.map((hit) => ({
        kind: 'vector',
        key: `${hit.docId}:${hit.index}`,
        title: `${hit.title} #${hit.index}`,
        reason,
        preview: hit.text,
        score: hit.score,
        source
      })),
      attempt: {
        source,
        query: normalizedQuery,
        outcome: hits.length > 0 ? 'hit' : 'empty',
        hitCount: hits.length
      },
      hits
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      messages: [],
      items: [],
      attempt: { source, query: normalizedQuery, outcome: 'failed', hitCount: 0, error: message },
      hits: []
    }
  }
}

function appendVectorAttempt(memory: MemoryContext, attempt: VectorMemoryAttempt, items: MemoryContextItem[]): void {
  const attempts = [...(memory.vectorTrace?.attempts ?? []), attempt]
  const existing = new Set(memory.vector.map((item) => item.key))
  for (const item of items) {
    if (!existing.has(item.key)) {
      memory.vector.push(item)
      existing.add(item.key)
    }
  }
  const hitCount = memory.vector.length
  const anyHit = attempts.some((item) => item.outcome === 'hit')
  const anyNonFailure = attempts.some((item) => item.outcome !== 'failed')
  const lastFailure = [...attempts].reverse().find((item) => item.outcome === 'failed')
  memory.vectorTrace = {
    attempted: attempts.length > 0,
    outcome: anyHit ? 'hit' : anyNonFailure ? 'empty' : 'failed',
    hitCount,
    query: attempts[0]?.query,
    error: !anyHit ? lastFailure?.error : undefined,
    attempts
  }
}

const MAX_SEARCH_TOOL_CALLS = 2
const MAX_TOOL_REPAIR_ATTEMPTS = 1

interface PendingToolCall {
  id: string
  name: string
  arguments: string
}

interface StreamToolDelta {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}

interface StreamRoundState {
  content: string
  reasoning: string
  pending: Map<number, PendingToolCall>
  finishReason?: string | null
  usage?: UsageLike
  /** Prefixes already exposed to the renderer; tool syntax is never exposed. */
  publishedContentLength: number
  publishedReasoningLength: number
}

/**
 * Several OpenAI-compatible thinking providers (notably DeepSeek) require the
 * model's reasoning_content to be replayed whenever a streamed assistant turn
 * is followed by another request. The OpenAI SDK does not model this vendor
 * extension, so keep it at the compatibility boundary instead of leaking it
 * into the persisted ChatMessage shape.
 */
type ThinkingCompatibleAssistantMessage = ChatCompletionMessageParam & {
  reasoning_content?: string
}

function appendAssistantTurnForReplay(
  conversation: ChatCompletionMessageParam[],
  state: StreamRoundState
): void {
  if (!state.content && !state.reasoning) return
  conversation.push({
    role: 'assistant',
    content: state.content || null,
    ...(state.reasoning ? { reasoning_content: state.reasoning } : {})
  } as ThinkingCompatibleAssistantMessage)
}

const PROJECT_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'search_project_source',
    description: 'Search indexed original project documents and resources. Use when supplied excerpts are insufficient, when the user asks for source details, or when a new keyword/name needs another lookup.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A short, precise source-search query.' },
        topK: { type: 'integer', minimum: 1, maximum: 5, description: 'Maximum source chunks to return.' }
      },
      required: ['query'],
      additionalProperties: false
    }
  }
} as const

function isToolCompatibilityError(error: unknown): boolean {
  const status = (error as { status?: number })?.status
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return (status === 400 || status === 404 || status === 422) &&
    /tools?|tool_choice|tool_calls?|functions?|function_call|unsupported|unknown parameter|unrecognized/.test(text)
}

function addUsage(total: UsageLike | undefined, next: UsageLike | undefined): UsageLike | undefined {
  if (!next) return total
  if (!total) return { ...next }
  return {
    prompt_tokens: total.prompt_tokens + next.prompt_tokens,
    completion_tokens: total.completion_tokens + next.completion_tokens,
    total_tokens: total.total_tokens + next.total_tokens
  }
}

/** Merge vendor-supplied incremental or cumulative stream fragments. */
function mergeStreamFragment(previous: string, incoming: string | undefined): string {
  if (!incoming) return previous
  if (!previous) return incoming
  if (incoming === previous || previous.endsWith(incoming)) return previous
  if (incoming.startsWith(previous)) return incoming

  const maxOverlap = Math.min(previous.length, incoming.length)
  for (let length = maxOverlap; length > 0; length--) {
    if (previous.slice(-length) === incoming.slice(0, length)) {
      return previous + incoming.slice(length)
    }
  }
  return previous + incoming
}

function parseSearchToolArguments(raw: string): { query: string; topK: number } | null {
  try {
    const value = JSON.parse(raw) as { query?: unknown; topK?: unknown }
    if (typeof value.query !== 'string' || !value.query.trim()) return null
    const requestedTopK = typeof value.topK === 'number' && Number.isFinite(value.topK) ? Math.round(value.topK) : 5
    return { query: value.query.trim(), topK: Math.max(1, Math.min(requestedTopK, 5)) }
  } catch {
    return null
  }
}

function toolResultContent(result: Awaited<ReturnType<typeof retrieveProjectOriginals>>): string {
  return JSON.stringify({
    query: result.attempt.query,
    outcome: result.attempt.outcome,
    hits: result.hits.map((hit) => ({
      sourceType: hit.kind,
      title: hit.title,
      chunk: hit.index,
      score: hit.score,
      text: hit.text
    }))
  })
}

function normalizeExplicitToolBody(content: string): string {
  const trimmed = content.trim()
  const xmlMatch = /^<tool_call>\s*([\s\S]*?)\s*<\/tool_call>$/i.exec(trimmed)
  return xmlMatch ? xmlMatch[1].trim() : trimmed
}

/**
 * Recover only an explicit, complete pseudo tool call; never infer intent from prose.
 */
function parseExplicitTextToolCall(content: string): PendingToolCall | null {
  const body = normalizeExplicitToolBody(content)
  const functionMatch = /^search_project_source\s*([\s\S]*)$/i.exec(body)
  if (functionMatch) {
    const argumentText = functionMatch[1].trim()
    if (!argumentText.startsWith('(') || !argumentText.endsWith(')')) return null
    const rawArguments = argumentText.slice(1, -1).trim()
    const args = parseSearchToolArguments(rawArguments)
    if (!args) return null
    return { id: '', name: 'search_project_source', arguments: JSON.stringify(args) }
  }

  try {
    const value = JSON.parse(body) as { name?: unknown; arguments?: unknown }
    if (value.name !== 'search_project_source') return null
    const rawArguments = typeof value.arguments === 'string'
      ? value.arguments
      : JSON.stringify(value.arguments ?? {})
    const args = parseSearchToolArguments(rawArguments)
    if (!args) return null
    return { id: '', name: 'search_project_source', arguments: JSON.stringify(args) }
  } catch {
    return null
  }
}

function looksLikeExplicitTextToolCall(content: string): boolean {
  const body = normalizeExplicitToolBody(content)
  if (/^search_project_source\s*\(/i.test(body)) return true
  if (/^\{\s*"name"\s*:\s*"search_project_source"\b/i.test(body)) return true
  return /^<tool_call>/i.test(content.trim())
}

function toolCallArguments(call: PendingToolCall): { query: string; topK: number } | null {
  return call.name === 'search_project_source' ? parseSearchToolArguments(call.arguments) : null
}

function isToolFinishReason(reason: string | null | undefined): boolean {
  return reason === 'tool_calls' || reason === 'tool_call' || reason === 'function_call'
}

function isTruncatedFinishReason(reason: string | null | undefined): boolean {
  return reason === 'length' || reason === 'max_tokens'
}

function buildToolRepairInstruction(lang: 'zh' | 'en'): ChatCompletionMessageParam {
  return {
    role: 'system',
    content: lang === 'en'
      ? 'The previous project-source tool call was incomplete or malformed. If source retrieval is needed, call only search_project_source with valid JSON arguments, for example {"query":"short precise query","topK":5}. Do not output the tool name, JSON, XML, or a pseudo-call as text. If retrieval is not needed, answer the user directly.'
      : '\u4e0a\u4e00\u8f6e\u7684\u9879\u76ee\u539f\u6587\u68c0\u7d22\u8c03\u7528\u4e0d\u5b8c\u6574\u6216\u683c\u5f0f\u9519\u8bef\u3002\u5982\u679c\u9700\u8981\u68c0\u7d22\uff0c\u8bf7\u53ea\u8c03\u7528 search_project_source\uff0c\u5e76\u63d0\u4f9b\u5408\u6cd5 JSON \u53c2\u6570\uff0c\u4f8b\u5982 {\"query\":\"\u7b80\u77ed\u4e14\u7cbe\u786e\u7684\u68c0\u7d22\u8bcd\",\"topK\":5}\u3002\u4e0d\u8981\u628a\u5de5\u5177\u540d\u3001JSON\u3001XML \u6216\u4f2a\u8c03\u7528\u6587\u672c\u4f5c\u4e3a\u666e\u901a\u6587\u5b57\u8f93\u51fa\u3002\u5982\u679c\u4e0d\u9700\u8981\u68c0\u7d22\uff0c\u8bf7\u76f4\u63a5\u56de\u7b54\u7528\u6237\u3002'
  }
}

function buildNoToolFallbackInstruction(lang: 'zh' | 'en'): ChatCompletionMessageParam {
  return {
    role: 'system',
    content: lang === 'en'
      ? 'Do not call any tool in this final attempt. Answer directly using the summaries and project-source excerpts already supplied in the conversation. If the evidence is insufficient, say so clearly; never claim that you lack permission to access project sources.'
      : '\u8fd9\u662f\u6700\u540e\u4e00\u6b21\u56de\u7b54\u5c1d\u8bd5\uff0c\u4e0d\u8981\u8c03\u7528\u4efb\u4f55\u5de5\u5177\u3002\u8bf7\u76f4\u63a5\u4f9d\u636e\u5f53\u524d\u5bf9\u8bdd\u4e2d\u5df2\u7ecf\u63d0\u4f9b\u7684\u6458\u8981\u548c\u9879\u76ee\u539f\u6587\u7247\u6bb5\u56de\u7b54\u3002\u5982\u679c\u8bc1\u636e\u4e0d\u8db3\uff0c\u8bf7\u660e\u786e\u8bf4\u660e\uff1b\u4e0d\u8981\u58f0\u79f0\u6ca1\u6709\u8bbf\u95ee\u9879\u76ee\u539f\u6587\u7684\u6743\u9650\u3002'
  }
}

function newStreamRound(): StreamRoundState {
  return {
    content: '',
    reasoning: '',
    pending: new Map(),
    publishedContentLength: 0,
    publishedReasoningLength: 0
  }
}

type ExplicitToolTextState = 'candidate' | 'answer'

/**
 * Keep a possible pseudo tool call private until the prefix is no longer
 * compatible with the supported formats. Ordinary answer text is released
 * immediately; this intentionally accepts the rare late native-tool signal.
 */
function classifyExplicitToolTextPrefix(content: string): ExplicitToolTextState {
  const trimmed = content.trimStart()
  if (!trimmed) return 'candidate'

  const lower = trimmed.toLowerCase()
  const functionName = 'search_project_source'
  if (functionName.startsWith(lower) || lower.startsWith(functionName)) return 'candidate'

  const xmlPrefix = '<tool_call>'
  if (xmlPrefix.startsWith(lower) || lower.startsWith(xmlPrefix)) return 'candidate'

  if (trimmed.startsWith('{')) {
    const compact = trimmed.replace(/\s+/g, '').toLowerCase()
    const jsonPrefix = '{"name":"search_project_source"'
    if (jsonPrefix.startsWith(compact) || compact.startsWith(jsonPrefix)) return 'candidate'
  }

  return 'answer'
}

function publishStreamRoundProgress(
  chatId: string,
  requestId: string,
  state: StreamRoundState,
  forceContent = false
): void {
  const nativeToolSignal = state.pending.size > 0 || isToolFinishReason(state.finishReason)
  const textMayBeToolCall = classifyExplicitToolTextPrefix(state.content) === 'candidate'
  const canPublishContent = forceContent || (!nativeToolSignal && !textMayBeToolCall)
  const delta = canPublishContent ? state.content.slice(state.publishedContentLength) : ''
  const reasoningDelta = state.reasoning.slice(state.publishedReasoningLength)

  if (canPublishContent) state.publishedContentLength = state.content.length
  state.publishedReasoningLength = state.reasoning.length
  if (delta || reasoningDelta) {
    broadcast(EVENTS.streamChunk, { chatId, requestId, delta, reasoningDelta: reasoningDelta || undefined })
  }
}

function protocolDuration(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt)
}

function toolProtocolLog(
  outcome: Parameters<typeof logToolProtocolEvent>[0]['outcome'],
  startedAt: number,
  state: StreamRoundState,
  toolCalls?: number
): void {
  logToolProtocolEvent({
    outcome,
    finishReason: state.finishReason,
    toolCalls,
    durationMs: protocolDuration(startedAt)
  })
}

async function streamAnswerWithTools(options: {
  client: OpenAI
  settings: ApiSettings
  messages: ChatCompletionMessageParam[]
  projectId: string
  memory: MemoryContext
  controller: AbortController
  chatId: string
  requestId: string
}): Promise<{ content: string; reasoning: string; usage?: UsageLike }> {
  const { client, settings, projectId, memory, controller, chatId, requestId } = options
  const capabilityInstruction: ChatCompletionMessageParam = {
    role: 'system',
    content: settings.language === 'en'
      ? 'The host already performs one automatic project-source search. When the search_project_source tool is available, call it only if you need a different query or more precise original evidence. Never claim you lack source access before using supplied excerpts or the available tool.'
      : '\u5bbf\u4e3b\u5df2\u81ea\u52a8\u6267\u884c\u4e00\u6b21\u9879\u76ee\u539f\u6587\u68c0\u7d22\u3002\u5982\u679c search_project_source \u5de5\u5177\u53ef\u7528\uff0c\u53ea\u5728\u9700\u8981\u6362\u68c0\u7d22\u8bcd\u6216\u8865\u5145\u66f4\u7cbe\u786e\u7684\u539f\u6587\u8bc1\u636e\u65f6\u8c03\u7528\u3002\u5728\u4f7f\u7528\u5df2\u63d0\u4f9b\u7684\u539f\u6587\u7247\u6bb5\u6216\u53ef\u7528\u5de5\u5177\u524d\uff0c\u4e0d\u5f97\u58f0\u79f0\u6ca1\u6709\u539f\u6587\u8bbf\u95ee\u6743\u9650\u3002'
  }
  const conversation: ChatCompletionMessageParam[] = [capabilityInstruction, ...options.messages]
  let content = ''
  let reasoning = ''
  let usage: UsageLike | undefined
  let executedToolCalls = 0
  let toolsDisabledForRequest = false
  let repairAttempts = 0
  let noToolFallbackUsed = false

  while (true) {
    const useTools = !toolsDisabledForRequest && executedToolCalls < MAX_SEARCH_TOOL_CALLS
    const roundStartedAt = Date.now()
    const state = newStreamRound()

    try {
      const stream = await client.chat.completions.create(
        {
          model: settings.model,
          messages: conversation,
          stream: true,
          ...(useTools ? { tools: [PROJECT_SEARCH_TOOL], tool_choice: 'auto' as const } : { stream_options: { include_usage: true } })
        },
        { signal: controller.signal }
      )

      for await (const chunk of stream) {
        const choice = chunk.choices?.[0] as
          | {
              finish_reason?: string | null
              delta?: {
                content?: string
                reasoning_content?: string
                reasoning?: string
                tool_calls?: StreamToolDelta[]
                function_call?: { name?: string; arguments?: string }
              }
            }
          | undefined
        if (choice?.finish_reason) state.finishReason = choice.finish_reason
        state.content = mergeStreamFragment(state.content, choice?.delta?.content)
        state.reasoning = mergeStreamFragment(state.reasoning, choice?.delta?.reasoning_content ?? choice?.delta?.reasoning)
        const legacyFunctionCall = choice?.delta?.function_call
        if (legacyFunctionCall) {
          const current = state.pending.get(0) ?? { id: '', name: '', arguments: '' }
          if (legacyFunctionCall.name) current.name = mergeStreamFragment(current.name, legacyFunctionCall.name)
          if (legacyFunctionCall.arguments) current.arguments = mergeStreamFragment(current.arguments, legacyFunctionCall.arguments)
          state.pending.set(0, current)
        }
        for (const delta of choice?.delta?.tool_calls ?? []) {
          const index = delta.index ?? 0
          const current = state.pending.get(index) ?? { id: '', name: '', arguments: '' }
          if (delta.id) current.id = mergeStreamFragment(current.id, delta.id)
          if (delta.function?.name) current.name = mergeStreamFragment(current.name, delta.function.name)
          if (delta.function?.arguments) current.arguments = mergeStreamFragment(current.arguments, delta.function.arguments)
          state.pending.set(index, current)
        }
        publishStreamRoundProgress(chatId, requestId, state)
        usage = addUsage(usage, chunk.usage as UsageLike | undefined)
      }
    } catch (error) {
      if (useTools && isToolCompatibilityError(error)) {
        reasoning += state.reasoning
        toolsDisabledForRequest = true
        toolProtocolLog('compatibility-retry', roundStartedAt, state)
        if (!noToolFallbackUsed) {
          conversation.push(buildNoToolFallbackInstruction(settings.language))
          noToolFallbackUsed = true
          logToolProtocolEvent({ outcome: 'no-tool-fallback', durationMs: protocolDuration(roundStartedAt) })
          continue
        }
      }
      throw error
    }

    if (controller.signal.aborted) {
      reasoning += state.reasoning
      return { content, reasoning, usage }
    }

    const nativeCalls = [...state.pending.values()].filter((call) => call.name || call.arguments)
    const explicitCall = parseExplicitTextToolCall(state.content)
    const hasExplicitSignal = looksLikeExplicitTextToolCall(state.content)
    const validNativeCall = nativeCalls.find((call) => !!toolCallArguments(call))
    const validCall = validNativeCall ?? explicitCall
    const hasToolSignal = nativeCalls.length > 0 || hasExplicitSignal || isToolFinishReason(state.finishReason)

    if (validCall && useTools) {
      reasoning += state.reasoning
      if (explicitCall && !validNativeCall) {
        toolProtocolLog('text-recovered', roundStartedAt, state, 1)
      } else {
        toolProtocolLog('native', roundStartedAt, state, nativeCalls.length || 1)
      }
      const assistantToolCall = {
        id: validCall.id || `search_project_source_${executedToolCalls}`,
        type: 'function' as const,
        function: { name: validCall.name, arguments: validCall.arguments }
      }
      conversation.push({
        role: 'assistant',
        content: null,
        ...(state.reasoning ? { reasoning_content: state.reasoning } : {}),
        tool_calls: [assistantToolCall]
      } as ThinkingCompatibleAssistantMessage)

      const args = toolCallArguments(validCall)
      const resultContent = args
        ? (() => {
            return retrieveProjectOriginals(projectId, args.query, settings.language, 'tool', '', args.topK)
          })()
        : null
      if (!resultContent) {
        conversation.push({
          role: 'tool',
          tool_call_id: assistantToolCall.id,
          content: JSON.stringify({ outcome: 'failed', error: 'Invalid tool arguments.' })
        } as ChatCompletionMessageParam)
      } else {
        const result = await resultContent
        appendVectorAttempt(memory, result.attempt, result.items)
        conversation.push({
          role: 'tool',
          tool_call_id: assistantToolCall.id,
          content: toolResultContent(result)
        } as ChatCompletionMessageParam)
      }
      executedToolCalls++
      continue
    }

    if (hasToolSignal && (!validCall || !useTools)) {
      reasoning += state.reasoning
      const outcome = isTruncatedFinishReason(state.finishReason) ? 'truncated' : 'malformed'
      toolProtocolLog(outcome, roundStartedAt, state, nativeCalls.length)
      if (repairAttempts < MAX_TOOL_REPAIR_ATTEMPTS && useTools) {
        repairAttempts++
        appendAssistantTurnForReplay(conversation, state)
        conversation.push(buildToolRepairInstruction(settings.language))
        logToolProtocolEvent({ outcome: 'repair', durationMs: protocolDuration(roundStartedAt) })
        continue
      }
      if (!noToolFallbackUsed) {
        toolsDisabledForRequest = true
        noToolFallbackUsed = true
        appendAssistantTurnForReplay(conversation, state)
        conversation.push(buildNoToolFallbackInstruction(settings.language))
        logToolProtocolEvent({ outcome: 'no-tool-fallback', durationMs: protocolDuration(roundStartedAt) })
        continue
      }
      throw new Error('\u6a21\u578b\u8fd4\u56de\u4e86\u65e0\u6cd5\u89e3\u6790\u7684\u5de5\u5177\u8c03\u7528\uff0c\u4e14\u4e00\u6b21\u683c\u5f0f\u4fee\u590d\u672a\u6210\u529f')
    }

    if (!state.content.trim() && !state.reasoning.trim()) {
      reasoning += state.reasoning
      if (!noToolFallbackUsed) {
        toolsDisabledForRequest = true
        noToolFallbackUsed = true
        appendAssistantTurnForReplay(conversation, state)
        conversation.push(buildNoToolFallbackInstruction(settings.language))
        logToolProtocolEvent({ outcome: 'no-tool-fallback', durationMs: protocolDuration(roundStartedAt) })
        continue
      }
      throw new Error('\u6a21\u578b\u8fd4\u56de\u4e3a\u7a7a')
    }

    content += state.content
    reasoning += state.reasoning
    publishStreamRoundProgress(chatId, requestId, state, true)
    return { content, reasoning, usage }
  }
}

function makeClient(baseURL: string, apiKey: string): OpenAI {
  return new OpenAI({ baseURL, apiKey, timeout: 180000, maxRetries: 0 })
}

// ---------------------------------------------------------------------------
// 上下文切片
// ---------------------------------------------------------------------------

interface ContextSlice {
  beforeText: string
  coreText: string
  afterText: string
}

export function sliceContext(content: string, range: StreamContextRange): ContextSlice {
  const n = content.length
  const hasSel =
    range.selectionFrom !== undefined &&
    range.selectionTo !== undefined &&
    range.selectionTo > range.selectionFrom
  const coreStart = hasSel ? Math.min(range.selectionFrom!, n) : Math.min(range.anchor, n)
  const coreEnd = hasSel ? Math.min(range.selectionTo!, n) : Math.min(range.anchor, n)
  const beforeStart = Math.max(0, coreStart - range.before)
  const afterEnd = Math.min(n, coreEnd + range.after)
  return {
    beforeText: content.slice(beforeStart, coreStart),
    coreText: content.slice(coreStart, coreEnd),
    afterText: content.slice(coreEnd, afterEnd)
  }
}

function buildContextBlock(slice: ContextSlice, lang: 'zh' | 'en'): string {
  const en = lang === 'en'
  const parts: string[] = []
  if (slice.beforeText) parts.push(`${en ? '[Before]' : '[前文]'}\n${slice.beforeText}`)
  if (slice.coreText) parts.push(`${en ? '[Core/Selection]' : '[核心内容/选区]'}\n${slice.coreText}`)
  else parts.push(en ? '[Cursor position]' : '[光标位置]')
  if (slice.afterText) parts.push(`${en ? '[After]' : '[后文]'}\n${slice.afterText}`)
  return `${en ? '【Document context】' : '【文档上下文】'}\n${parts.join('\n\n')}`
}

// ---------------------------------------------------------------------------
// Token 预算（PRD 6.7）
// ---------------------------------------------------------------------------

function tok(content: unknown, model: string): number {
  return estimateTokens(typeof content === 'string' ? content : '', model)
}

function messageTokens(message: ChatCompletionMessageParam, model: string): number {
  const reasoningContent = (message as { reasoning_content?: unknown }).reasoning_content
  return tok(message.content, model) + tok(reasoningContent, model)
}

function truncateToTokens(text: string, maxTokens: number, model: string): string {
  if (tok(text, model) <= maxTokens) return text
  const chars = [...text]
  let lo = 0
  let hi = chars.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (tok(chars.slice(0, mid).join(''), model) <= maxTokens) lo = mid
    else hi = mid - 1
  }
  return chars.slice(0, lo).join('')
}

function lastUserAttachments(history: ChatMessage[]): string[] {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    if (m.role === 'user' && m.attachments?.length) {
      return m.attachments.map((a) => a.snapshotId).filter((x): x is string => !!x)
    }
  }
  return []
}

function lastUserDocAttachments(history: ChatMessage[]): string[] {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    if (m.role === 'user' && m.attachments?.length) {
      return m.attachments.map((a) => a.docId).filter((x): x is string => !!x)
    }
  }
  return []
}

/**
 * 预算裁剪优先级（从高到低保留）：
 * 系统提示 → 关联文档全文/切片 → 文档摘要 → 资源快照 → 对话摘要 → 资源摘要 → 对话历史
 * auxMsgs 按优先级从高到低排列，超预算时从尾部（资源摘要）开始丢弃。
 */
function applyBudget(
  systemMsgs: ChatCompletionMessageParam[],
  auxMsgs: ChatCompletionMessageParam[],
  historyMsgs: ChatCompletionMessageParam[],
  tailMsgs: ChatCompletionMessageParam[],
  model: string,
  contextLimit: number
): ChatCompletionMessageParam[] {
  const inputBudget = Math.max(1000, Math.floor(contextLimit * 0.8))
  const totalOf = (arr: ChatCompletionMessageParam[]): number =>
    arr.reduce((s, m) => s + messageTokens(m, model), 0)

  let h = [...historyMsgs]
  let a = [...auxMsgs]
  let used = totalOf(systemMsgs) + totalOf(a) + totalOf(h) + totalOf(tailMsgs)

  // 1) 裁剪历史（从最旧开始）
  while (used > inputBudget && h.length) {
    h.shift()
    used = totalOf(systemMsgs) + totalOf(a) + totalOf(h) + totalOf(tailMsgs)
  }
  // 2) 丢弃低优先级摘要（从尾部 = 资源摘要开始）
  while (used > inputBudget && a.length) {
    a.pop()
    used = totalOf(systemMsgs) + totalOf(a) + totalOf(h) + totalOf(tailMsgs)
  }
  // 3) 最后：截断关联文档全文/切片块（systemMsgs[1]）
  if (used > inputBudget && systemMsgs.length > 1) {
    const ctxMsg = systemMsgs[1]
    const ctxText = typeof ctxMsg.content === 'string' ? ctxMsg.content : ''
    const others = used - tok(ctxText, model)
    const needed = Math.max(0, inputBudget - others)
    systemMsgs[1] = { role: 'system', content: truncateToTokens(ctxText, needed, model) }
  }

  return [...systemMsgs, ...a, ...h, ...tailMsgs]
}

// ---------------------------------------------------------------------------
// 摘要注入（候选收集 / 相关度采样 / 激活键计算已抽到 ../summary-relevance，供渲染层与主进程共用）
// ---------------------------------------------------------------------------

async function injectSummaries(
  chat: ChatMeta,
  docContent: string | null,
  tree: ProjectTree | undefined,
  activeKeys: Set<string>
): Promise<{
  docMsgs: ChatCompletionMessageParam[]
  chatMsgs: ChatCompletionMessageParam[]
  resourceMsgs: ChatCompletionMessageParam[]
  items: MemoryContextItem[]
}> {
  const docMsgs: ChatCompletionMessageParam[] = []
  const chatMsgs: ChatCompletionMessageParam[] = []
  const resourceMsgs: ChatCompletionMessageParam[] = []
  const items: MemoryContextItem[] = []

  const cfg = await loadConfig()
  if (!cfg.summaryEnabled) return { docMsgs, chatMsgs, resourceMsgs, items }
  const lang = cfg.language ?? 'zh'
  const inj = cfg.summaryInjection
  const projectId = chat.projectId
  if (!tree) return { docMsgs, chatMsgs, resourceMsgs, items }

  const kind = chat.kind

  // 文档摘要
  let docIds: string[] = []
  if (kind === 'project' && inj.project.docSummaries) {
    docIds = tree.docs.map((d) => d.id)
  } else if (kind === 'doc' && inj.doc.otherDocSummaries) {
    docIds = tree.docs.filter((d) => d.id !== chat.docId).map((d) => d.id)
  } else if (kind === 'context' && inj.context.docSummaries) {
    docIds = tree.docs.map((d) => d.id) // 含关联文档
  }
  for (const docId of docIds) {
    if (!activeKeys.has(`doc:${docId}`)) continue
    let summary: DocSummary | null = null
    if (kind === 'context' && docId === chat.docId && docContent !== null) {
      summary = await ensureDocSummary(projectId, docId, docContent)
    } else {
      summary = await readDocSummary(projectId, docId)
    }
    if (summary) {
      const title = tree.docs.find((d) => d.id === docId)?.title ?? docId
      docMsgs.push({ role: 'system', content: buildDocSummaryBlock(summary, lang) })
      items.push({ kind: 'doc', key: `doc:${docId}`, title })
    }
  }

  // 对话摘要
  let chatIds: string[] = []
  if (kind === 'project' && inj.project.chatSummaries) {
    chatIds = tree.chats.filter((c) => c.id !== chat.id).map((c) => c.id)
  } else if (kind === 'doc' && inj.doc.docChatSummaries) {
    chatIds = tree.chats.filter((c) => c.docId === chat.docId && c.id !== chat.id).map((c) => c.id)
  } else if (kind === 'context' && inj.context.docChatSummaries) {
    chatIds = tree.chats.filter((c) => c.docId === chat.docId && c.id !== chat.id).map((c) => c.id)
  }
  for (const chatId of chatIds) {
    if (!activeKeys.has(`chat:${chatId}`)) continue
    const s = await readChatSummary(projectId, chatId)
    if (s && (s.items.length > 0 || (s.compacted?.length ?? 0) > 0)) {
      const title = tree.chats.find((c) => c.id === chatId)?.title ?? chatId
      chatMsgs.push({ role: 'system', content: buildChatSummaryBlock(s, lang) })
      items.push({ kind: 'chat', key: `chat:${chatId}`, title })
    }
  }

  // 资源摘要
  const includeResources =
    kind === 'project' ? inj.project.resourceSummaries : kind === 'doc' ? inj.doc.resourceSummaries : inj.context.resourceSummaries
  if (includeResources) {
    for (const r of tree.resources) {
      if (!activeKeys.has(`res:${r.id}`)) continue
      try {
        const resource = await readResource(projectId, r.id)
        if (resource.encoding.suspicious) continue
        const summary = await readResourceSummary(projectId, r.id)
        if (summary) {
          resourceMsgs.push({ role: 'system', content: buildResourceSummaryBlock(summary, r.name, lang) })
          items.push({ kind: 'res', key: `res:${r.id}`, title: r.name })
        }
      } catch {
        // A broken resource must not block the whole conversation.
      }
    }
  }

  return { docMsgs, chatMsgs, resourceMsgs, items }
}

// ---------------------------------------------------------------------------
// 组装消息
// ---------------------------------------------------------------------------

/** 重新生成引导：告知模型用户对上一回答不满意、扩大了上下文/补充了摘要 */
async function buildRegenerateGuidance(
  req: StreamRequest,
  chat: ChatMeta,
  docContent: string | null,
  lang: 'zh' | 'en'
): Promise<string | null> {
  const reason = req.regenerateReason
  if (!reason) return null
  const en = lang === 'en'
  const blocks: string[] = []

  // 新增上下文片段（与锁定的旧范围对比）
  if (
    (reason === 'context' || reason === 'both') &&
    chat.kind === 'context' &&
    req.contextRange &&
    chat.lockedRange &&
    docContent !== null
  ) {
    const old = chat.lockedRange
    const range = req.contextRange
    const hasSel =
      range.selectionFrom !== undefined && range.selectionTo !== undefined && range.selectionTo > range.selectionFrom
    const coreStart = hasSel ? range.selectionFrom! : range.anchor
    const coreEnd = hasSel ? range.selectionTo! : range.anchor
    const n = docContent.length
    if (range.before > old.before) {
      const from = Math.max(0, coreStart - range.before)
      const to = Math.max(0, Math.min(coreStart - old.before, n))
      if (to > from) blocks.push(`${en ? '【New context · before】' : '【新增上下文·前文】'}\n${docContent.slice(from, to).slice(0, 4000)}`)
    }
    if (range.after > old.after) {
      const from = Math.min(coreEnd + old.after, n)
      const to = Math.min(coreEnd + range.after, n)
      if (to > from) blocks.push(`${en ? '【New context · after】' : '【新增上下文·后文】'}\n${docContent.slice(from, to).slice(0, 4000)}`)
    }
  }

  // 新增摘要
  if ((reason === 'summary' || reason === 'both') && req.newlyEnabledSummaries?.length) {
    for (const key of req.newlyEnabledSummaries) {
      if (key.startsWith('doc:')) {
        const s = await readDocSummary(chat.projectId, key.slice(4))
        if (s) blocks.push(buildDocSummaryBlock(s, lang))
      } else if (key.startsWith('chat:')) {
        const s = await readChatSummary(chat.projectId, key.slice(5))
        if (s && (s.items.length > 0 || (s.compacted?.length ?? 0) > 0)) blocks.push(buildChatSummaryBlock(s, lang))
      } else if (key.startsWith('res:')) {
        const resId = key.slice(4)
        try {
          const resource = await readResource(chat.projectId, resId)
          if (resource.encoding.suspicious) continue
          const summary = await readResourceSummary(chat.projectId, resId)
          if (summary) {
            const tree = (await buildSnapshot()).projects.find((project) => project.project.id === chat.projectId)
            const name = tree?.resources.find((resourceMeta) => resourceMeta.id === resId)?.name ?? (en ? 'resource' : '\u8d44\u6e90')
            blocks.push(buildResourceSummaryBlock(summary, name, lang))
          }
        } catch {
          // Deleted or unreadable resources are ignored for regenerated guidance.
        }
      }
    }
  }

  if (blocks.length === 0) return null

  const intro = en
    ? reason === 'context'
      ? '[Important] The user is not satisfied with the previous answer and has expanded the context range. Read the following new context excerpts carefully and adjust your new answer accordingly:'
      : reason === 'summary'
        ? '[Important] The user is not satisfied with the previous answer and has added the following summary context. Incorporate this new information into your new answer:'
        : '[Important] The user is not satisfied with the previous answer, has expanded the context range and added summary context. Read the following new content carefully and adjust your new answer accordingly:'
    : reason === 'context'
      ? '【重要】用户对上一个回答不满意，并扩大了上下文读取范围。请着重阅读以下【新增上下文】片段，并据此调整你的新回答：'
      : reason === 'summary'
        ? '【重要】用户对上一个回答不满意，并补充了以下摘要上下文。请结合这些新信息调整你的新回答：'
        : '【重要】用户对上一个回答不满意，扩大了上下文读取范围并补充了摘要上下文。请着重阅读以下新增内容，并据此调整你的新回答：'

  return `${intro}\n\n${blocks.join('\n\n')}`
}

async function buildMessages(
  req: StreamRequest,
  chat: ChatMeta,
  history: ChatMessage[],
  appendUser: boolean
): Promise<{ messages: ChatCompletionMessageParam[]; memory: MemoryContext }> {
  const cfg = await loadConfig()
  const settings = await loadApiSettings()
  const tree = (await buildSnapshot()).projects.find((p) => p.project.id === chat.projectId)
  const applicable = collectApplicableKeys(chat, cfg, tree)
  const defaultSelected = await selectDefaultKeys(chat, applicable)
  const activeKeys = computeActiveKeys(chat, applicable, defaultSelected)
  const lang = cfg.language ?? 'zh'
  const en = lang === 'en'

  const systemMsgs: ChatCompletionMessageParam[] = [{ role: 'system', content: buildSystemPrompt(lang) }]

  // 关联文档上下文（切片 或 全文）
  let docContent: string | null = null
  if (chat.kind === 'context' && chat.docId && req.contextRange) {
    const content = (await readDoc(req.contextRange.docId)).content
    if (!analyzeTextIntegrity(content).suspicious) {
      docContent = content
      const slice = sliceContext(docContent, req.contextRange)
      systemMsgs.push({ role: 'system', content: buildContextBlock(slice, lang) })
    }
  } else if (chat.kind === 'doc' && chat.docId) {
    // 文档级对话：读取全文用于触发摘要检测（PRD 7.2），并按配置注入全文
    const content = (await readDoc(chat.docId)).content
    if (!analyzeTextIntegrity(content).suspicious) {
      docContent = content
      if (cfg.summaryEnabled) {
        await ensureDocSummary(chat.projectId, chat.docId, docContent)
      }
      if (cfg.summaryInjection.doc.fullText && activeKeys.has('fulltext')) {
        const label = en ? '\u3010Full text of linked document\u3011' : '\u3010\u5173\u8054\u6587\u6863\u5168\u6587\u3011'
        systemMsgs.push({ role: 'system', content: `${label}\n${docContent}` })
      }
    }
  }

  // 重新生成引导（扩大范围/补充摘要）
  if (req.regenerate && req.regenerateReason) {
    const guidance = await buildRegenerateGuidance(req, chat, docContent, lang)
    if (guidance) systemMsgs.push({ role: 'system', content: guidance })
  }

  // 摘要注入：文档摘要 > 资源快照 > 对话摘要 > 资源摘要（按优先级排列）
  const { docMsgs, chatMsgs, resourceMsgs, items } = await injectSummaries(chat, docContent, tree, activeKeys)

  const snapshotMsgs: ChatCompletionMessageParam[] = []
  const snapshotIds = req.snapshotIds ?? lastUserAttachments(history)
  for (const sid of snapshotIds) {
    const snap = await readSnapshot(chat.projectId, chat.id, sid)
    if (snap && !analyzeTextIntegrity(snap.content).suspicious) {
      snapshotMsgs.push({ role: 'system', content: `${en ? '【Uploaded file: ' : '【用户上传文件：'}${snap.name}】\n${snap.content}` })
    }
  }

  // 附加文档：读当前内容一次性注入；与全文注入去重（同文档已全文注入则跳过）
  const fullTextDocIds = new Set<string>()
  if (chat.kind === 'doc' && chat.docId && cfg.summaryInjection.doc.fullText && activeKeys.has('fulltext')) {
    fullTextDocIds.add(chat.docId)
  }
  const docIds = req.docIds ?? lastUserDocAttachments(history)
  for (const docId of docIds) {
    if (fullTextDocIds.has(docId)) continue
    try {
      const { doc, content } = await readDoc(docId)
      if (analyzeTextIntegrity(content).suspicious) continue
      snapshotMsgs.push({ role: 'system', content: `${en ? '【Attached document: ' : '【附加文档：'}${doc.title}】\n${content}` })
    } catch {
      /* 文档已删除等，跳过 */
    }
  }

  const auxMsgs: ChatCompletionMessageParam[] = [...docMsgs, ...snapshotMsgs, ...chatMsgs, ...resourceMsgs]

  // 历史
  const historyMsgs: ChatCompletionMessageParam[] = history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
      ...(m.role === 'assistant' && m.reasoning ? { reasoning_content: m.reasoning } : {})
    } as ThinkingCompatibleAssistantMessage))

  const tailMsgs: ChatCompletionMessageParam[] = appendUser
    ? [{ role: 'user', content: req.userText }]
    : []

  const messages = applyBudget(systemMsgs, auxMsgs, historyMsgs, tailMsgs, settings.model, settings.contextLimit)
  const memory: MemoryContext = { small: items, rollups: [], vector: [] }
  return { messages, memory }
}

// ---------------------------------------------------------------------------
// 流式请求
// ---------------------------------------------------------------------------

/**
 * 任何异常都必须广播 stream:done（带 error），保证渲染层不会卡在“输入中”。
 */
export async function streamChat(req: StreamRequest): Promise<void> {
  try {
    await streamChatInner(req)
  } catch (err) {
    const done: StreamDonePayload = {
      chatId: req.chatId,
      requestId: req.requestId,
      content: '',
      error: (err as Error).message
    }
    broadcast(EVENTS.streamDone, done)
  }
}

async function streamChatInner(req: StreamRequest): Promise<void> {
  const settings = await loadApiSettings()
  const { chat, messages } = await getChat(req.chatId)

  // 组装本次请求的历史与用户消息
  let historyForPrompt: ChatMessage[]

  if (req.regenerate) {
    // 去掉最后一条 assistant 回答，保留用户输入
    let lastAssistantIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        lastAssistantIdx = i
        break
      }
    }
    historyForPrompt = lastAssistantIdx >= 0 ? messages.filter((_, i) => i !== lastAssistantIdx) : messages
  } else {
    const attachments: ChatAttachment[] = []
    for (const sid of req.snapshotIds ?? []) {
      const snap = await readSnapshot(chat.projectId, chat.id, sid)
      if (snap) attachments.push({ snapshotId: sid, name: snap.name })
    }
    for (const docId of req.docIds ?? []) {
      try {
        const { doc } = await readDoc(docId)
        attachments.push({ docId, name: doc.title })
      } catch {
        /* 文档已删除等，跳过 */
      }
    }
    await appendMessage(req.chatId, {
      id: req.userMessageId,
      role: 'user',
      content: req.userText,
      createdAt: nowIso(),
      attachments
    })
    historyForPrompt = (await getChat(req.chatId)).messages
  }

  const built = await buildMessages(req, chat, historyForPrompt, !req.regenerate)

  if (!settings.apiKey) {
    const done: StreamDonePayload = { chatId: req.chatId, requestId: req.requestId, content: '', error: '未配置 API Key，请先在设置中配置' }
    broadcast(EVENTS.streamDone, done)
    return
  }

  const client = makeClient(settings.baseURL, settings.apiKey)
  const controller = new AbortController()
  controllers.set(req.requestId, controller)

  // C-layer retrieval starts in the host. It never depends on summary settings,
  // regenerate mode, or whether a model follows a planning prompt.
  let finalMessages = built.messages
  if (shouldAutoRetrieve(req.userText)) {
    const automatic = await retrieveProjectOriginals(chat.projectId, req.userText, settings.language, 'automatic')
    finalMessages = insertIntoSystemPrefix(finalMessages, automatic.messages)
    appendVectorAttempt(built.memory, automatic.attempt, automatic.items)
  } else {
    built.memory.vectorTrace = { attempted: false, outcome: 'skipped', hitCount: 0, attempts: [] }
  }

  // B-layer planning only expands rollups. Original-source retrieval is handled
  // independently by the host and the bounded search tool loop.
  if (!req.regenerate) {
    const cfg = await loadConfig()
    if (cfg.summaryEnabled) {
      const rollups = await readDocRollups(chat.projectId)
      try {
        const plan = await planMemory(settings, built.messages, rollups)
        finalMessages = insertIntoSystemPrefix(finalMessages, plan.extraMsgs)
        built.memory.rollups.push(...plan.rollupItems)
        if (plan.reason) built.memory.reason = plan.reason
      } catch {
        // Rollup planning failure must not discard host retrieval or block the answer.
      }
    }
  }

  finalMessages = insertIntoSystemPrefix(finalMessages, [{
    role: 'system',
    content: settings.language === 'en'
      ? 'Project original-text excerpts, when present above, were retrieved by the host application. Use them as source evidence. If retrieval returned nothing, say that no relevant excerpt was found; do not claim that you lack permission to access project sources.'
      : '\u4e0a\u65b9\u5982\u6709\u9879\u76ee\u539f\u6587\u7247\u6bb5\uff0c\u5b83\u4eec\u7531\u5bbf\u4e3b\u7a0b\u5e8f\u68c0\u7d22\u5e76\u53ef\u4f5c\u4e3a\u4f5c\u7b54\u8bc1\u636e\u3002\u82e5\u672a\u547d\u4e2d\uff0c\u5e94\u8bf4\u660e\u672c\u6b21\u68c0\u7d22\u672a\u627e\u5230\u76f8\u5173\u539f\u6587\uff0c\u4e0d\u8981\u58f0\u79f0\u6ca1\u6709\u8bbf\u95ee\u9879\u76ee\u539f\u6587\u7684\u6743\u9650\u3002'
  }])

  let acc = ''
  let reasoning = ''
  let usage: UsageLike | undefined
  let failed = false
  let persistedMessageId: string | undefined

  try {
    const result = await streamAnswerWithTools({
      client,
      settings,
      messages: finalMessages,
      projectId: chat.projectId,
      memory: built.memory,
      controller,
      chatId: req.chatId,
      requestId: req.requestId
    })
    acc = result.content
    reasoning = result.reasoning
    usage = result.usage

    if (controller.signal.aborted) {
      broadcast(EVENTS.streamDone, {
        chatId: req.chatId,
        requestId: req.requestId,
        content: '',
        aborted: true
      })
      return
    }
  } catch (err) {
    if (controller.signal.aborted) {
      broadcast(EVENTS.streamDone, {
        chatId: req.chatId,
        requestId: req.requestId,
        content: '',
        aborted: true
      })
      return
    }
    failed = true
    broadcast(EVENTS.streamDone, {
      chatId: req.chatId,
      requestId: req.requestId,
      content: acc,
      reasoning: reasoning || undefined,
      error: (err as Error).message
    })
  } finally {
    controllers.delete(req.requestId)
  }

  // 成功：持久化回答（含思维链）+ 记录用量
  if (!failed && acc.length > 0) {
    if (req.regenerate) {
      persistedMessageId = (await replaceLastAssistantMessage(req.chatId, acc, reasoning || undefined, built.memory)) ?? undefined
    }
    if (!persistedMessageId) {
      persistedMessageId = newId()
      await appendMessage(req.chatId, {
        id: persistedMessageId,
        role: 'assistant',
        content: acc,
        createdAt: nowIso(),
        reasoning: reasoning || undefined,
        memory: built.memory
      })
    }
  }

  if (usage) await recordUsage(usage, 'chat')
  else if (!failed && !controller.signal.aborted) {
    await recordUsage(undefined, 'chat')
  }

  if (!failed) {
    broadcast(EVENTS.streamDone, {
      chatId: req.chatId,
      requestId: req.requestId,
      content: acc,
      reasoning: reasoning || undefined,
      usage: usage ? { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, total_tokens: usage.total_tokens } : undefined,
      memory: built.memory,
      messageId: persistedMessageId,
      regenerated: req.regenerate
    })
  }
}

// ---------------------------------------------------------------------------
// 记忆规划：模型先判断是否需要补充大摘要或发起向量检索（透明展示）
// ---------------------------------------------------------------------------
// Rollup planning (B layer). C-layer source search is host-controlled elsewhere.
// ---------------------------------------------------------------------------

function parseRollupPlan(raw: string): { needs: string[]; reason: string } | null {
  const cleaned = raw.trim().replace(/```(?:json)?/gi, '').trim()
  const candidates = [cleaned, cleaned.match(/\{[\s\S]*\}/)?.[0] ?? '']
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as { needs?: unknown; reason?: unknown }
      if (!Array.isArray(value.needs)) continue
      return {
        needs: value.needs.filter((item): item is string => typeof item === 'string').slice(0, 5),
        reason: typeof value.reason === 'string' ? value.reason.trim() : ''
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

async function planMemory(
  settings: ApiSettings,
  messages: ChatCompletionMessageParam[],
  rollups: DocRollup[]
): Promise<{
  extraMsgs: ChatCompletionMessageParam[]
  rollupItems: MemoryContextItem[]
  reason: string
}> {
  if (rollups.length === 0) return { extraMsgs: [], rollupItems: [], reason: '' }
  const en = settings.language === 'en'
  const catalog = buildRollupCatalogBlock(rollups, settings.language)
  const latestUser = [...messages].reverse().find((message) => message.role === 'user')
  const userText = typeof latestUser?.content === 'string' ? latestUser.content : ''
  const instruction = en
    ? 'Select document rollups only when they add useful broader context for the current request. Output JSON only: {"needs":["id"],"reason":"short reason"}. Use at most 5 valid ids; use an empty array when no rollup is needed.'
    : '\u53ea\u5728\u5f53\u524d\u8bf7\u6c42\u9700\u8981\u66f4\u5e7f\u7684\u6587\u6863\u80cc\u666f\u65f6\u9009\u62e9\u5927\u6458\u8981\u3002\u4ec5\u8f93\u51fa JSON\uff1a{"needs":["id"],"reason":"\u7b80\u77ed\u7406\u7531"}\u3002needs \u6700\u591a 5 \u4e2a\u4e14\u5fc5\u987b\u662f\u76ee\u5f55\u4e2d\u7684 id\uff1b\u4e0d\u9700\u8981\u65f6\u8f93\u51fa\u7a7a\u6570\u7ec4\u3002'
  const decision = await executeStructuredTask({
    task: 'memory_rollup_plan',
    settings,
    messages: [
      { role: 'system', content: instruction },
      { role: 'user', content: `${catalog}\n\n${en ? 'Current request' : '\u5f53\u524d\u8bf7\u6c42'}:\n${userText}` }
    ],
    outputTokens: 300,
    compactOutputTokens: 220,
    parseAndValidate: parseRollupPlan,
    jsonSchema: {
      type: 'object',
      properties: {
        needs: { type: 'array', items: { type: 'string' }, maxItems: 5 },
        reason: { type: 'string' }
      },
      required: ['needs', 'reason'],
      additionalProperties: false
    }
  })

  const extraMsgs: ChatCompletionMessageParam[] = []
  const rollupItems: MemoryContextItem[] = []
  const byId = new Map(rollups.map((rollup) => [rollup.id, rollup]))
  const label = en ? 'Docs' : '\u7b2c'
  const suffix = en ? '' : ' \u7bc7'
  for (const id of decision.needs) {
    const rollup = byId.get(id)
    if (!rollup) continue
    extraMsgs.push({ role: 'system', content: buildRollupBlock(rollup, settings.language) })
    rollupItems.push({
      kind: 'rollup',
      key: rollup.id,
      title: `${label} ${rollup.rangeLabel}${suffix}`,
      reason: decision.reason
    })
  }
  return { extraMsgs, rollupItems, reason: decision.reason }
}

// ---------------------------------------------------------------------------
// Automatic chat-title generation
// ---------------------------------------------------------------------------

export async function generateChatTitle(chatId: string): Promise<{ ok: boolean; title?: string; error?: string }> {
  try {
    const settings = await loadApiSettings()
    if (!settings.apiKey) return { ok: false, error: '未配置 API Key' }
    const { messages } = await getChat(chatId)
    const turns = messages.filter((m) => m.role === 'user' || m.role === 'assistant')
    if (turns.length === 0) return { ok: false, error: '对话为空，无法生成标题' }

    const client = makeClient(settings.baseURL, settings.apiKey)
    const en = settings.language === 'en'
    const dialogue = turns
      .map((m) => `${m.role === 'user' ? (en ? 'User' : '用户') : 'AI'}：${m.content}`)
      .join('\n')
      .slice(0, 8000)
    const res = await client.chat.completions.create({
      model: settings.model,
      messages: [
        {
          role: 'system',
          content: en
            ? 'Generate a short title (max 20 words) for the following writing discussion. Output only the title text, written in English.'
            : '请为下面这段写作讨论对话生成一个简短标题（不超过 20 字），只输出标题文本本身。'
        },
        { role: 'user', content: dialogue }
      ],
      temperature: 0.3,
      max_tokens: 64
    })
    if (res.usage) await recordUsage(res.usage, 'summary')
    const title = (res.choices[0]?.message?.content ?? '').trim().slice(0, 20)
    if (!title) return { ok: false, error: '标题生成失败' }
    await renameChat(chatId, title)
    return { ok: true, title }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export async function testConnection(): Promise<ConnectionTestResult> {
  const settings = await loadApiSettings()
  if (!settings.apiKey) return { ok: false, message: '未配置 API Key' }
  try {
    const client = makeClient(settings.baseURL, settings.apiKey)
    await client.models.list()
    return { ok: true, message: `连接成功（模型：${settings.model}）` }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}

/** 获取可用模型列表（优先使用调用方传入的 URL/Key，用于设置页未保存的新配置） */
export async function listModels(req: { baseURL?: string; apiKey?: string }): Promise<{ ok: boolean; models?: string[]; error?: string }> {
  try {
    const settings = await loadApiSettings()
    const baseURL = req.baseURL?.trim() || settings.baseURL
    const apiKey = req.apiKey?.trim() || settings.apiKey
    if (!apiKey) return { ok: false, error: '未配置 API Key' }
    const client = makeClient(baseURL, apiKey)
    const res = await client.models.list()
    const models = (res.data ?? []).map((m) => String(m.id ?? m ?? '')).filter((s) => s.length > 0)
    return { ok: true, models }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
