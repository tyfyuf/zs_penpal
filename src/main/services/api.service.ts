import type { LlmAdapter } from './llm/llm-client'
import { createLlmAdapter, createOpenAIClient } from './llm/llm-client'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import type {
  AppConfig,
  ChatAction,
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
import {
  collectApplicableKeys,
  computeActiveKeys,
  selectDefaultKeys,
  selectDynamicKeys,
  updateChatRelevanceLearning
} from '../summary-relevance'
import {
  buildChatSummaryBlock,
  buildDocSummaryBlock,
  buildResourceSummaryBlock,
  buildRollupBlock,
  buildRollupCatalogBlock,
  getUsableDocRollups,
} from './summary.service'
import { ensureDocSummaryInWorker } from './summary-job-manager'
import { ensureProjectDocSummariesReady, type SummaryReadinessUpdate } from './doc-summary-maintenance.service'
import { isShortDocForSummary, isSourceStale, nonWhitespaceLength } from '../summary-source'
import { logChatCompatibilityEvent, logToolProtocolEvent } from './log.service'
import { recordUsage } from './usage.service'
import { executeStructuredTask } from './structured-generation.service'
import {
  enableReasoningReplay,
  loadModelCapabilityProfile,
  modelCapabilityFingerprint
} from './llm/model-capabilities'
import { isReasoningReplayRequiredError } from './llm/reasoning'
import { searchVectorIndex } from './vector.service'
import {
  appendMessage,
  buildSnapshot,
  getChat,
  readChatSummary,
  readDoc,
  readDocSummary,
  readResource,
  readResourceSummary,
  readSnapshot,
  renameChat,
  replaceLastAssistantMessage,
  updateChatMeta
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
    return `You are the writing assistant of Penpal (笔伴). Your job is to help the writer make decisions, not to replace their writing.
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
  return `你是「笔伴（Penpal）」的写作助手，职责是辅助创作者决策，不替代创作者完成写作成果。
规则：
1. 你不得自动修改用户的写作文档，也不得自动生成、替换或导出成品文件。
2. 你可以在对话中给出诊断、优化文本、改写示例和后续走向建议，表达形式不限。
3. 你的输出只显示在对话区，由用户自行判断并手动复制粘贴。
风格要求：
- 理性务实：结论先行，理由具体、可验证，少用修辞与客套；
- 直接指出问题与可操作的改进点，不空泛鼓励；
- 涉及原文引用或改写时保持准确，不确定之处明确说明。
请用中文回答。`
}/** Build the task-specific role contract for Context chats.
 *
 * This deliberately stays in the single chat request: it borrows OpenFic's
 * separation of agent responsibilities without introducing extra LLM calls.
 */
export function buildContextActionPrompt(
  action: ChatAction | undefined,
  lang: 'zh' | 'en',
  compareWrittenContinuation = false
): string {
  const languageInstruction = lang === 'en'
    ? 'Always respond in English.'
    : '\u8bf7\u7528\u4e2d\u6587\u56de\u7b54\u3002'
  const shared = `Context-chat role contract:
- This window is focused on the selected excerpt of one writing document.
- Treat the supplied document excerpt as source text. Do not invent facts that are not supported by it or by clearly identified conversation context.
- The author makes the final decisions. Give analysis, options and examples in chat; never modify the document automatically.
- Keep the current role as the primary focus. You may answer a different explicit sub-question briefly, but do not let it replace the current role.
- Separate observations grounded in the excerpt from inferences and recommendations. State uncertainty when the available context is insufficient.
- ${languageInstruction}`

  if (!action) {
    return `${shared}

Current role: general context assistant.
Help the author understand and discuss the selected passage without assuming that the task is literary optimization, narrative diagnosis or plot projection. When the user's intent is ambiguous, ask a focused clarification question or clearly separate the possible readings.`
  }

  if (action === 'optimize') {
    return `${shared}

Current role: literary editor for the selected passage.
Primary objective: improve the passage's literary effect while preserving its established plot facts, character identities, worldbuilding and intended meaning.
Focus on:
- diction, sentence and paragraph quality, narrative voice, point of view and clarity;
- rhythm, pacing, emotional transmission, imagery, sensory detail and atmosphere;
- dialogue, character presentation and the timing of information disclosure.
Response priorities:
1. Assess the current literary effect.
2. Identify the highest-value improvements and explain why they matter.
3. Offer concrete revision directions and, when useful, short local rewrite examples.
Do not make logic diagnosis the main task. Mention a logic issue only briefly when it directly harms the literary effect. Do not mechanically rewrite the entire passage unless the author explicitly asks for that.`
  }

  if (action === 'diagnose') {
    return `${shared}

Current role: narrative and character-behavior diagnostician for the selected passage.
Primary objective: determine whether the passage is coherent within its surrounding narrative and whether the characters' actions are adequately motivated.
Check:
- causal links, chronology, scene transitions and information flow;
- what each character knows at the moment of acting, their motives, choices and reactions;
- continuity with the surrounding narrative, established setting and character facts;
- whether conflict escalation and consequences are supported by the text.
Response priorities:
1. State the overall judgment first.
2. Identify concrete problems, the location or trigger of each problem, and the reason it is a problem.
3. Distinguish confirmed problems, plausible reader-confusion risks and issues that depend on the author's intention or later text.
4. Give targeted repair directions.
Do not turn this into a literary-polish pass or a long rewrite. Any rewrite must serve a specific logic, causality or behavior repair, not merely improve style.`
  }

  const continuationRule = compareWrittenContinuation
    ? `

Special rule for this context: the excerpt contains a substantial piece of text after the anchor or within the selected continuation. Treat that material as the author's already-written continuation, not as blank future space. First derive possible branches from the anchor situation; then compare each branch with the author's written continuation. State which branch it follows or diverges from, what the written version gains or risks, which branches it rules out, and which possibilities remain open. Keep the comparison explicit and do not merely retell the supplied text.`
    : ''
  return `${shared}

Current role: plot-development analyst for the selected passage.
Primary objective: project plausible developments after the anchor and help the author choose among them.
First identify the current situation, active conflict, unresolved pressure, character positions and meaningful suspense. Then propose 2-4 distinct plausible branches. For each branch, explain its core development, trigger or prerequisite, effects on characters and conflict, and major risks.
Do not present a speculative branch as an established fact, force a single answer, or spend the response mainly polishing or repeating the current passage. Base projections on textual evidence and clearly label inference.${continuationRule}`
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
  state: StreamRoundState,
  replayReasoning: boolean
): void {
  if (!state.content && !state.reasoning) return
  conversation.push({
    role: 'assistant',
    content: state.content || null,
    ...(replayReasoning && state.reasoning ? { reasoning_content: state.reasoning } : {})
  } as ThinkingCompatibleAssistantMessage)
}

function hasAssistantReasoning(messages: ChatMessage[]): boolean {
  return messages.some((message) => message.role === 'assistant' && !!message.reasoning?.trim())
}

function compactCompatibilityError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, ' ').slice(0, 300)
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
  toolCalls?: number,
  protocol: ApiSettings['apiProtocol'] = 'chat_completions'
): void {
  logToolProtocolEvent({
    protocol,
    outcome,
    finishReason: state.finishReason,
    toolCalls,
    durationMs: protocolDuration(startedAt)
  })
}

async function streamAnswerWithTools(options: {
  client: LlmAdapter
  settings: ApiSettings
  messages: ChatCompletionMessageParam[]
  projectId: string
  memory: MemoryContext
  controller: AbortController
  chatId: string
  requestId: string
  replayReasoning: boolean
}): Promise<{ content: string; reasoning: string; usage?: UsageLike }> {
  const { client, settings, projectId, memory, controller, chatId, requestId, replayReasoning } = options
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
      const stream = await client.createChatCompletionStream(
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
      if (useTools && isToolCompatibilityError(error) && !isReasoningReplayRequiredError(error)) {
        reasoning += state.reasoning
        toolsDisabledForRequest = true
        toolProtocolLog('compatibility-retry', roundStartedAt, state, undefined, settings.apiProtocol)
        if (!noToolFallbackUsed) {
          conversation.push(buildNoToolFallbackInstruction(settings.language))
          noToolFallbackUsed = true
          logToolProtocolEvent({ protocol: settings.apiProtocol, outcome: 'no-tool-fallback', durationMs: protocolDuration(roundStartedAt) })
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
        toolProtocolLog('text-recovered', roundStartedAt, state, 1, settings.apiProtocol)
      } else {
        toolProtocolLog('native', roundStartedAt, state, nativeCalls.length || 1, settings.apiProtocol)
      }
      const assistantToolCall = {
        id: validCall.id || `search_project_source_${executedToolCalls}`,
        type: 'function' as const,
        function: { name: validCall.name, arguments: validCall.arguments }
      }
      conversation.push({
        role: 'assistant',
        content: null,
        ...(replayReasoning && state.reasoning ? { reasoning_content: state.reasoning } : {}),
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
      toolProtocolLog(outcome, roundStartedAt, state, nativeCalls.length, settings.apiProtocol)
      if (repairAttempts < MAX_TOOL_REPAIR_ATTEMPTS && useTools) {
        repairAttempts++
        appendAssistantTurnForReplay(conversation, state, replayReasoning)
        conversation.push(buildToolRepairInstruction(settings.language))
        logToolProtocolEvent({ protocol: settings.apiProtocol, outcome: 'repair', durationMs: protocolDuration(roundStartedAt) })
        continue
      }
      if (!noToolFallbackUsed) {
        toolsDisabledForRequest = true
        noToolFallbackUsed = true
        appendAssistantTurnForReplay(conversation, state, replayReasoning)
        conversation.push(buildNoToolFallbackInstruction(settings.language))
        logToolProtocolEvent({ protocol: settings.apiProtocol, outcome: 'no-tool-fallback', durationMs: protocolDuration(roundStartedAt) })
        continue
      }
      throw new Error('\u6a21\u578b\u8fd4\u56de\u4e86\u65e0\u6cd5\u89e3\u6790\u7684\u5de5\u5177\u8c03\u7528\uff0c\u4e14\u4e00\u6b21\u683c\u5f0f\u4fee\u590d\u672a\u6210\u529f')
    }

    if (!state.content.trim() && !state.reasoning.trim()) {
      reasoning += state.reasoning
      if (!noToolFallbackUsed) {
        toolsDisabledForRequest = true
        noToolFallbackUsed = true
        appendAssistantTurnForReplay(conversation, state, replayReasoning)
        conversation.push(buildNoToolFallbackInstruction(settings.language))
        logToolProtocolEvent({ protocol: settings.apiProtocol, outcome: 'no-tool-fallback', durationMs: protocolDuration(roundStartedAt) })
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

function makeClient(settings: ApiSettings): LlmAdapter {
  return createLlmAdapter(settings)
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

function buildContextBlock(slice: ContextSlice, source: { id: string; title: string }, lang: 'zh' | 'en'): string {
  const en = lang === 'en'
  const title = source.title.replace(/[\r\n]+/g, ' ').trim() || source.id
  const parts: string[] = []
  if (slice.beforeText) parts.push(`${en ? '[Before]' : '[\u524d\u6587]'}\n${slice.beforeText}`)
  if (slice.coreText) parts.push(`${en ? '[Core/Selection]' : '[\u6838\u5fc3\u5185\u5bb9/\u9009\u533a]'}\n${slice.coreText}`)
  else parts.push(en ? '[Cursor position]' : '[\u5149\u6807\u4f4d\u7f6e]')
  if (slice.afterText) parts.push(`${en ? '[After]' : '[\u540e\u6587]'}\n${slice.afterText}`)
  const sourceLine = en
    ? `Source document: ${title} (ID: ${source.id})`
    : `\u6765\u6e90\u6587\u6863\uff1a${title}\uff08ID\uff1a${source.id}\uff09`
  return `${en ? '\u3010Document context\u3011' : '\u3010\u6587\u6863\u4e0a\u4e0b\u6587\u3011'}\n${sourceLine}\n${en ? 'The following is an excerpt from this document.' : '\u4ee5\u4e0b\u662f\u8be5\u6587\u6863\u7684\u539f\u6587\u5207\u7247\u3002'}\n${parts.join('\n\n')}`
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

type PromptAttachmentSource = 'current_user_message_attachment' | 'message_attachment'

function attachmentKind(attachment: ChatAttachment): 'project_document' | 'resource' {
  if (attachment.kind) return attachment.kind
  return attachment.docId ? 'project_document' : 'resource'
}

function cleanAttachmentName(name: string | undefined, fallback: string): string {
  const cleaned = (name ?? '').replace(/[\r\n]+/g, ' ').trim()
  return cleaned || fallback
}

/**
 * Gives the model a stable message-level attachment identity without changing
 * the user-visible message stored in the chat history.
 */
function formatAttachmentIdentity(
  attachments: ChatAttachment[] | undefined,
  lang: 'zh' | 'en',
  source: PromptAttachmentSource,
  messageId: string
): string {
  if (!attachments?.length) return ''
  const en = lang === 'en'
  const sourceLabel = source === 'current_user_message_attachment'
    ? (en ? 'current_user_message_attachment' : '当前用户消息附件')
    : (en ? 'message_attachment' : '历史消息附件')
  const rows = attachments.map((attachment) => {
    const kind = attachmentKind(attachment)
    const id = attachment.docId ?? attachment.snapshotId ?? 'unknown'
    const fallback = kind === 'project_document' ? 'untitled document' : 'unnamed resource'
    const name = cleanAttachmentName(attachment.name, fallback)
    const typeLabel = kind === 'project_document'
      ? (en ? 'project writing document' : '项目写作文档')
      : (en ? 'uploaded resource file' : '用户上传资源文件')
    return en
      ? `- name: ${name} | type: ${typeLabel} | identity ID: ${id} | source: ${sourceLabel}`
      : `- 《${name}》｜类型：${typeLabel}｜身份 ID：${id}｜来源：${sourceLabel}`
  })
  const instruction = source === 'current_user_message_attachment'
    ? (en
      ? 'If the user says "this file", "this document", "this story", or similar, first resolve the reference to the attachment(s) on this user message. If multiple attachments make the reference ambiguous, ask the user to clarify instead of guessing.'
      : '如果用户说“这份文件”、“这个文档”、“这个故事”、“这个设定”或类似指代，优先将其理解为本条用户消息附带的附件；如果本条有多个附件而无法唯一判断，不要猜测，应请用户澄清。')
    : (en
      ? 'These files belonged to this historical user message. Keep their identity tied to that message; do not treat them as attachments of the current user message.'
      : '这些文件属于这条历史用户消息，仅与该条消息绑定；不要将它们误认为当前用户消息的附件。')
  return en
    ? `<message_attachments message_id="${messageId}" source="${sourceLabel}">\n${rows.join('\n')}\n${instruction}\n</message_attachments>`
    : `【消息附件身份：${sourceLabel}】\n消息 ID：${messageId}\n${rows.join('\n')}\n${instruction}\n【消息附件身份结束】`

}

function formatUserPromptContent(
  content: string,
  attachments: ChatAttachment[] | undefined,
  lang: 'zh' | 'en',
  source: PromptAttachmentSource,
  messageId: string
): string {
  const identity = formatAttachmentIdentity(attachments, lang, source, messageId)
  return identity ? `${content}\n\n${identity}` : content
}

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
  // 3) Finally truncate the linked document context block. The role contract may
  // precede it, so do not rely on a fixed system-message index.
  const contextIndex = systemMsgs.findIndex((message, index) => {
    if (index === 0 || typeof message.content !== 'string') return false
    return message.content.includes('[Document context]') || message.content.includes('\u3010\u6587\u6863\u4e0a\u4e0b\u6587\u3011')
  })
  if (used > inputBudget && contextIndex >= 0) {
    const ctxMsg = systemMsgs[contextIndex]
    const ctxText = typeof ctxMsg.content === 'string' ? ctxMsg.content : ''
    const others = used - tok(ctxText, model)
    const needed = Math.max(0, inputBudget - others)
    systemMsgs[contextIndex] = { role: 'system', content: truncateToTokens(ctxText, needed, model) }
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
    const title = tree.docs.find((d) => d.id === docId)?.title ?? docId
    let content: string | null = null
    try {
      content = docId === chat.docId && docContent !== null ? docContent : (await readDoc(docId)).content
    } catch {
      // A stored summary remains usable if the source is temporarily unreadable.
    }

    if (content !== null) {
      if (nonWhitespaceLength(content) === 0) continue
      if (isShortDocForSummary(content)) {
        const heading = lang === 'en'
          ? `【Short document full text】\nSource document: ${title} (ID: ${docId})\nThis document is shorter than the summary threshold, so its full text is supplied as reference material.`
          : `【短文档全文】\n来源文档：${title}（ID：${docId}）\n该文档短于摘要阈值，因此直接提供全文作为参考资料。`
        docMsgs.push({ role: 'system', content: `${heading}\n${content}` })
        items.push({ kind: 'doc', key: `doc:${docId}`, title })
        continue
      }
    }

    const summary = await readDocSummary(projectId, docId)
    if (!summary) continue
    let status: 'fresh' | 'stale' | 'incomplete' = summary.generation.state === 'incomplete' ? 'incomplete' : 'fresh'
    if (content !== null && status === 'fresh' && isSourceStale(summary, content)) status = 'stale'
    docMsgs.push({ role: 'system', content: buildDocSummaryBlock(summary, { id: docId, title }, lang, status) })
    items.push({ kind: 'doc', key: `doc:${docId}`, title })
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
      chatMsgs.push({ role: 'system', content: buildChatSummaryBlock(s, { id: chatId, title }, lang) })
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
  const tree = (await buildSnapshot()).projects.find((project) => project.project.id === chat.projectId)

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
      if (to > from) {
        const title = tree?.docs.find((doc) => doc.id === chat.docId)?.title ?? chat.docId
        const label = en
          ? `\u3010New context \u00b7 before\u3011\nSource document: ${title} (ID: ${chat.docId})`
          : `\u3010\u65b0\u589e\u4e0a\u4e0b\u6587\u00b7\u524d\u6587\u3011\n\u6765\u6e90\u6587\u6863\uff1a${title}\uff08ID\uff1a${chat.docId}\uff09`
        blocks.push(`${label}\n${docContent.slice(from, to).slice(0, 4000)}`)
      }
    }
    if (range.after > old.after) {
      const from = Math.min(coreEnd + old.after, n)
      const to = Math.min(coreEnd + range.after, n)
      if (to > from) {
        const title = tree?.docs.find((doc) => doc.id === chat.docId)?.title ?? chat.docId
        const label = en
          ? `\u3010New context \u00b7 after\u3011\nSource document: ${title} (ID: ${chat.docId})`
          : `\u3010\u65b0\u589e\u4e0a\u4e0b\u6587\u00b7\u540e\u6587\u3011\n\u6765\u6e90\u6587\u6863\uff1a${title}\uff08ID\uff1a${chat.docId}\uff09`
        blocks.push(`${label}\n${docContent.slice(from, to).slice(0, 4000)}`)
      }
    }
  }

  // 新增摘要
  if ((reason === 'summary' || reason === 'both') && req.newlyEnabledSummaries?.length) {
    for (const key of req.newlyEnabledSummaries) {
      if (key.startsWith('doc:')) {
        const docId = key.slice(4)
        const s = await readDocSummary(chat.projectId, docId)
        if (s) {
          const title = tree?.docs.find((doc) => doc.id === docId)?.title ?? docId
          blocks.push(buildDocSummaryBlock(s, { id: docId, title }, lang))
        }
      } else if (key.startsWith('chat:')) {
        const chatId = key.slice(5)
        const s = await readChatSummary(chat.projectId, chatId)
        if (s && (s.items.length > 0 || (s.compacted?.length ?? 0) > 0)) {
          const title = tree?.chats.find((candidate) => candidate.id === chatId)?.title ?? chatId
          blocks.push(buildChatSummaryBlock(s, { id: chatId, title }, lang))
        }
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

function truncatePlanningText(text: string, maxChars = 2600): string {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}…` : normalized
}

function buildPlanningConversation(history: ChatMessage[], currentMessageId: string, lang: 'zh' | 'en'): string {
  const conversation = history.filter((message) => message.role === 'user' || message.role === 'assistant')
  let currentIndex = -1
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const message = conversation[index]
    if (message.role === 'user' && (message.id === currentMessageId || currentIndex < 0)) {
      currentIndex = index
      if (message.id === currentMessageId) break
    }
  }
  const rounds: { user: ChatMessage; assistant: ChatMessage }[] = []
  for (let index = 0; index < currentIndex; index += 1) {
    const user = conversation[index]
    const assistant = conversation[index + 1]
    if (user?.role !== 'user' || assistant?.role !== 'assistant') continue
    rounds.push({ user, assistant })
    index += 1
  }
  const selected = rounds.slice(-3)
  const en = lang === 'en'
  const lines = selected.map((round, index) => en
    ? `[Completed turn ${index + 1}]\nUser: ${truncatePlanningText(round.user.content)}\nAssistant: ${truncatePlanningText(round.assistant.content)}`
    : `【已完成第 ${index + 1} 轮】\n用户：${truncatePlanningText(round.user.content)}\n助手：${truncatePlanningText(round.assistant.content)}`)
  const current = conversation[currentIndex]
  if (current?.role === 'user') {
    lines.push(en
      ? `[Current unanswered request]\nUser: ${truncatePlanningText(current.content)}`
      : `【当前尚未回答的请求】\n用户：${truncatePlanningText(current.content)}`)
  }
  return lines.join('\n\n')
}

type MessageBuildParts = {
  systemMsgs: ChatCompletionMessageParam[]
  highPriorityAuxMsgs: ChatCompletionMessageParam[]
  resourceMsgs: ChatCompletionMessageParam[]
  rollupMsgs: ChatCompletionMessageParam[]
  historyMsgs: ChatCompletionMessageParam[]
  tailMsgs: ChatCompletionMessageParam[]
  memory: MemoryContext
}

async function buildMessages(
  req: StreamRequest,
  chat: ChatMeta,
  history: ChatMessage[],
  appendUser: boolean,
  replayReasoning: boolean,
  ensureSummaries?: () => Promise<string[]>
): Promise<MessageBuildParts> {
  const cfg = await loadConfig()
  const settings = await loadApiSettings()
  const failedDocSummaries = await (ensureSummaries ?? (() => ensureProjectDocSummariesReady(chat.projectId)))()
  if (failedDocSummaries.length > 0) {
    const names = failedDocSummaries.slice(0, 5).map((name) => `《${name}》`).join('、')
    const more = failedDocSummaries.length > 5 ? `等 ${failedDocSummaries.length} 个文档` : ''
    throw new Error(cfg.language === 'en'
      ? `Document summaries could not be generated for: ${failedDocSummaries.slice(0, 5).join(', ')}${failedDocSummaries.length > 5 ? ` and ${failedDocSummaries.length - 5} more` : ''}. Check the summary model and API settings, then retry.`
      : `以下文档摘要生成失败：${names}${more ? `、${more}` : ''}。请检查摘要模型与 API 设置后重试。`)
  }
  const tree = (await buildSnapshot()).projects.find((p) => p.project.id === chat.projectId)
  const applicable = collectApplicableKeys(chat, cfg, tree)
  const defaultSelected = await selectDefaultKeys(chat, applicable, tree, cfg)
  const dynamicSelected = await selectDynamicKeys(chat, applicable, tree, defaultSelected, cfg)
  const activeKeys = computeActiveKeys(chat, applicable, defaultSelected, dynamicSelected)
  const lang = cfg.language ?? 'zh'
  const en = lang === 'en'

  const systemMsgs: ChatCompletionMessageParam[] = [{ role: 'system', content: buildSystemPrompt(lang) }]
  const projectDocs = new Map(
    (tree?.docs ?? [])
      .filter((doc) => doc.projectId === chat.projectId)
      .map((doc) => [doc.id, doc] as const)
  )
  const attachmentSource: PromptAttachmentSource = appendUser
    ? 'current_user_message_attachment'
    : 'message_attachment'
  const attachmentMessageId = appendUser
    ? req.userMessageId
    : [...history].reverse().find((message) => message.role === 'user' && message.attachments?.length)?.id ?? req.userMessageId

  let docContent: string | null = null
  let compareWrittenContinuation = false
  if (chat.kind === 'context' && chat.docId && req.contextRange && projectDocs.has(chat.docId)) {
    const contextDocId = chat.docId
    const content = (await readDoc(contextDocId)).content
    if (!analyzeTextIntegrity(content).suspicious) {
      docContent = content
      const slice = sliceContext(docContent, req.contextRange)
      const title = projectDocs.get(contextDocId)?.title ?? contextDocId
      const hasLongSelectedText = req.contextRange.selectionFrom !== undefined && req.contextRange.selectionTo !== undefined && req.contextRange.selectionTo > req.contextRange.selectionFrom && slice.coreText.trim().length >= 500
      const hasLongFollowingText = slice.afterText.trim().length >= 500
      compareWrittenContinuation = chat.action === 'plot' && (hasLongSelectedText || hasLongFollowingText)
      systemMsgs.push({ role: 'system', content: buildContextBlock(slice, { id: contextDocId, title }, lang) })
    }
  } else if (chat.kind === 'doc' && chat.docId && projectDocs.has(chat.docId)) {
    const content = (await readDoc(chat.docId)).content
    if (!analyzeTextIntegrity(content).suspicious) {
      docContent = content
      if (cfg.summaryInjection.doc.fullText && activeKeys.has('fulltext')) {
        const title = projectDocs.get(chat.docId)?.title ?? chat.docId
        const label = en
          ? `[Full text of linked document]\nSource document: ${title} (ID: ${chat.docId})`
          : `【关联文档全文】\n来源文档：《${title}》（ID：${chat.docId}）`
        systemMsgs.push({ role: 'system', content: `${label}\n${docContent}` })
      }
    }
  }

  if (chat.kind === 'context') {
    const rolePrompt = buildContextActionPrompt(chat.action, lang, compareWrittenContinuation)
    systemMsgs.splice(1, 0, { role: 'system', content: rolePrompt })
  }

  if (req.regenerate && req.regenerateReason) {
    const guidance = await buildRegenerateGuidance(req, chat, docContent, lang)
    if (guidance) systemMsgs.push({ role: 'system', content: guidance })
  }

  const { docMsgs, chatMsgs, resourceMsgs, items } = await injectSummaries(chat, docContent, tree, activeKeys)

  const snapshotMsgs: ChatCompletionMessageParam[] = []
  const snapshotIds = req.snapshotIds ?? lastUserAttachments(history)
  for (const sid of snapshotIds) {
    const snap = await readSnapshot(chat.projectId, chat.id, sid)
    if (snap && !analyzeTextIntegrity(snap.content).suspicious) {
      const heading = en
        ? `[Message attachment: uploaded resource]\nFile name: ${snap.name}\nFile identity ID: ${sid}\nAttachment message ID: ${attachmentMessageId}\nAttachment source: ${attachmentSource}\nThe following is the content of this resource file:`
        : `【消息附件：已上传资源】\n文件名称：《${snap.name}》\n文件身份 ID：${sid}\n附件消息 ID：${attachmentMessageId}\n附件来源：${attachmentSource === 'current_user_message_attachment' ? '当前用户消息附件' : '历史消息附件'}\n以下是该资源文件的内容：`
      const ending = en ? '\n[End of attached resource file]' : '\n【已上传资源文件结束】'
      snapshotMsgs.push({ role: 'system', content: `${heading}\n${snap.content}${ending}` })
    }
  }

  const fullTextDocIds = new Set<string>()
  if (chat.kind === 'doc' && chat.docId && cfg.summaryInjection.doc.fullText && activeKeys.has('fulltext')) {
    fullTextDocIds.add(chat.docId)
  }
  const docIds = req.docIds ?? lastUserDocAttachments(history)
  for (const docId of docIds) {
    if (fullTextDocIds.has(docId)) continue
    const projectDoc = projectDocs.get(docId)
    if (!projectDoc) continue
    try {
      const { content } = await readDoc(docId)
      if (analyzeTextIntegrity(content).suspicious) continue
      const heading = en
        ? `[Message attachment: project writing document]\nDocument name: ${projectDoc.title}\nDocument identity ID: ${docId}\nAttachment message ID: ${attachmentMessageId}\nAttachment source: ${attachmentSource}\nThe following is the full text of this document:`
        : `【消息附件：项目写作文档】\n文档名称：《${projectDoc.title}》\n文档身份 ID：${docId}\n附件消息 ID：${attachmentMessageId}\n附件来源：${attachmentSource === 'current_user_message_attachment' ? '当前用户消息附件' : '历史消息附件'}\n以下为该文档全文：`
      const ending = en ? '\n[End of attached project document]' : '\n【项目写作文档结束】'
      snapshotMsgs.push({ role: 'system', content: `${heading}\n${content}${ending}` })
    } catch {
      /* 文档已删除等，跳过 */
    }
  }

  const historyMsgs: ChatCompletionMessageParam[] = history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.role === 'user'
        ? formatUserPromptContent(m.content, m.attachments, lang, m.id === req.userMessageId && appendUser
          ? 'current_user_message_attachment'
          : 'message_attachment',
          m.id)
        : m.content,
      ...(replayReasoning && m.role === 'assistant' && m.reasoning ? { reasoning_content: m.reasoning } : {})
    } as ThinkingCompatibleAssistantMessage))

  const currentUserMessage = history.find((m) => m.role === 'user' && m.id === req.userMessageId)
  const tailMsgs: ChatCompletionMessageParam[] = appendUser
    ? [{
        role: 'user',
        content: formatUserPromptContent(req.userText, currentUserMessage?.attachments, lang, 'current_user_message_attachment', req.userMessageId)
      }]
    : []

  const rollupMsgs: ChatCompletionMessageParam[] = []
  const rollupItems: MemoryContextItem[] = []
  let rollupReason = ''
  if (!req.regenerate && cfg.summaryEnabled) {
    try {
      const rollups = await getUsableDocRollups(chat.projectId)
      const plan = await planMemory(settings, rollups, buildPlanningConversation(history, req.userMessageId, lang))
      rollupMsgs.push(...plan.extraMsgs)
      rollupItems.push(...plan.rollupItems)
      rollupReason = plan.reason
    } catch {
      // Rollup planning is optional; a failed planner must not block the answer.
    }
  }

  return {
    systemMsgs,
    highPriorityAuxMsgs: [...docMsgs, ...snapshotMsgs, ...chatMsgs],
    resourceMsgs,
    rollupMsgs,
    historyMsgs,
    tailMsgs,
    memory: { small: items, rollups: rollupItems, vector: [], ...(rollupReason ? { reason: rollupReason } : {}) }
  }
}

async function learnConversationRelevance(
  chatId: string,
  history: ChatMessage[],
  userText: string,
  attachments: ChatAttachment[] | undefined,
  assistantText: string
): Promise<void> {
  const userCount = history.filter((message) => message.role === 'user').length
  const assistantCount = history.filter((message) => message.role === 'assistant').length + 1
  const completedRounds = Math.min(userCount, assistantCount)
  const attachedNames = (attachments ?? []).map((attachment) => attachment.name).filter(Boolean)
  const learningUserText = [userText, ...attachedNames].join('\n')
  try {
    const { chat: latestChat } = await getChat(chatId)
    const learning = updateChatRelevanceLearning(
      latestChat.summaryLearning,
      learningUserText,
      assistantText,
      Math.max(latestChat.summaryLearning?.completedRounds ?? 0, completedRounds)
    )
    await updateChatMeta(chatId, { summaryLearning: learning })
  } catch {
    // Relevance learning is an optional optimization and must never fail a chat turn.
  }
}

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
      if (snap) attachments.push({ snapshotId: sid, kind: 'resource', name: snap.name })
    }
    const tree = (await buildSnapshot()).projects.find((p) => p.project.id === chat.projectId)
    const projectDocIds = new Set(
      (tree?.docs ?? []).filter((doc) => doc.projectId === chat.projectId).map((doc) => doc.id)
    )
    for (const docId of req.docIds ?? []) {
      if (!projectDocIds.has(docId)) continue
      try {
        const { doc } = await readDoc(docId)
        if (doc.projectId !== chat.projectId) continue
        attachments.push({ docId, kind: 'project_document', name: doc.title })
      } catch {
        /* Ignore an attachment that can no longer be read. */
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

  if (!settings.apiKey) {
    const done: StreamDonePayload = { chatId: req.chatId, requestId: req.requestId, content: '', error: '未配置 API Key，请先在设置中配置' }
    broadcast(EVENTS.streamDone, done)
    return
  }

  const client = makeClient(settings)
  const controller = new AbortController()
  controllers.set(req.requestId, controller)

  let compatibility = await loadModelCapabilityProfile(settings)
  let replayReasoning = compatibility.reasoningReplay
  let summaryReadinessPromise: Promise<string[]> | null = null
  const ensureSummaries = (): Promise<string[]> => {
    if (!summaryReadinessPromise) {
      summaryReadinessPromise = ensureProjectDocSummariesReady(chat.projectId, (progress: SummaryReadinessUpdate) => {
        broadcast(EVENTS.summaryReadiness, {
          requestId: req.requestId,
          chatId: chat.id,
          ...progress
        })
      })
    }
    return summaryReadinessPromise
  }
  const prepareMessages = async (replay: boolean): Promise<{ messages: ChatCompletionMessageParam[]; memory: MemoryContext }> => {
    const built = await buildMessages(req, chat, historyForPrompt, !req.regenerate, replay, ensureSummaries)
    const auxMsgs = [...built.highPriorityAuxMsgs, ...built.rollupMsgs, ...built.resourceMsgs]
    let finalMessages = applyBudget(
      built.systemMsgs,
      auxMsgs,
      built.historyMsgs,
      built.tailMsgs,
      settings.model,
      settings.contextLimit
    )

    // C-layer retrieval starts in the host. It never depends on summary settings,
    // regenerate mode, or whether a model follows a planning prompt.
    if (shouldAutoRetrieve(req.userText)) {
      const automatic = await retrieveProjectOriginals(chat.projectId, req.userText, settings.language, 'automatic')
      finalMessages = insertIntoSystemPrefix(finalMessages, automatic.messages)
      appendVectorAttempt(built.memory, automatic.attempt, automatic.items)
    } else {
      built.memory.vectorTrace = { attempted: false, outcome: 'skipped', hitCount: 0, attempts: [] }
    }

    finalMessages = insertIntoSystemPrefix(finalMessages, [{
      role: 'system',
      content: settings.language === 'en'
        ? 'Project original-text excerpts, when present above, were retrieved by the host application. Use them as source evidence. If retrieval returned nothing, say that no relevant excerpt was found; do not claim that you lack permission to access project sources.'
        : '\u4e0a\u65b9\u5982\u6709\u9879\u76ee\u539f\u6587\u7247\u6bb5\uff0c\u5b83\u4eec\u7531\u5bbf\u4e3b\u7a0b\u5e8f\u68c0\u7d22\u5e76\u53ef\u4f5c\u4e3a\u4f5c\u7b54\u8bc1\u636e\u3002\u82e5\u672a\u547d\u4e2d\uff0c\u5e94\u8bf4\u660e\u672c\u6b21\u68c0\u7d22\u672a\u627e\u5230\u76f8\u5173\u539f\u6587\uff0c\u4e0d\u8981\u58f0\u79f0\u6ca1\u6709\u8bbf\u95ee\u9879\u76ee\u539f\u6587\u7684\u6743\u9650\u3002'
    }])

    return { messages: finalMessages, memory: built.memory }
  }
  let prepared = await prepareMessages(replayReasoning === 'when_present')

  let acc = ''
  let reasoning = ''
  let usage: UsageLike | undefined
  let failed = false
  let persistedMessageId: string | undefined

  try {
    const runPreparedChat = () => streamAnswerWithTools({
      client,
      settings,
      messages: prepared.messages,
      projectId: chat.projectId,
      memory: prepared.memory,
      controller,
      chatId: req.chatId,
      requestId: req.requestId,
      replayReasoning: replayReasoning === 'when_present'
    })

    let result
    try {
      result = await runPreparedChat()
    } catch (error) {
      const shouldLearnReplay = settings.apiProtocol === 'chat_completions'
        && replayReasoning === 'never'
        && !controller.signal.aborted
        && hasAssistantReasoning(historyForPrompt)
        && isReasoningReplayRequiredError(error)
      if (!shouldLearnReplay) throw error

      const retryStartedAt = Date.now()
      compatibility = await enableReasoningReplay(settings)
      replayReasoning = compatibility.reasoningReplay
      prepared = await prepareMessages(true)
      try {
        result = await runPreparedChat()
        logChatCompatibilityEvent({
          protocol: settings.apiProtocol,
          providerFamily: compatibility.providerFamily,
          reasoningReplay: compatibility.reasoningReplay,
          endpointKey: modelCapabilityFingerprint(compatibility),
          outcome: 'learned-retry',
          durationMs: Date.now() - retryStartedAt,
          error: compactCompatibilityError(error)
        })
      } catch (retryError) {
        logChatCompatibilityEvent({
          protocol: settings.apiProtocol,
          providerFamily: compatibility.providerFamily,
          reasoningReplay: compatibility.reasoningReplay,
          endpointKey: modelCapabilityFingerprint(compatibility),
          outcome: 'retry-failure',
          durationMs: Date.now() - retryStartedAt,
          error: compactCompatibilityError(retryError)
        })
        throw retryError
      }
    }
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
      persistedMessageId = (await replaceLastAssistantMessage(req.chatId, acc, reasoning || undefined, prepared.memory)) ?? undefined
    }
    if (!persistedMessageId) {
      persistedMessageId = newId()
      await appendMessage(req.chatId, {
        id: persistedMessageId,
        role: 'assistant',
        content: acc,
        createdAt: nowIso(),
        reasoning: reasoning || undefined,
        memory: prepared.memory
      })
    }
  }

  if (!failed && !req.regenerate && acc.length > 0) {
    const currentUser = historyForPrompt.find((message) => message.id === req.userMessageId)
    await learnConversationRelevance(req.chatId, historyForPrompt, req.userText, currentUser?.attachments, acc)
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
      memory: prepared.memory,
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
  rollups: DocRollup[],
  planningConversation: string
): Promise<{
  extraMsgs: ChatCompletionMessageParam[]
  rollupItems: MemoryContextItem[]
  reason: string
}> {
  if (rollups.length === 0) return { extraMsgs: [], rollupItems: [], reason: '' }
  const en = settings.language === 'en'
  const catalog = buildRollupCatalogBlock(rollups, settings.language)
  const instruction = en
    ? 'The conversation excerpt below belongs only to the current chat window. Use its last 3 completed user-assistant turns plus the current unanswered request to learn the active topic. Select document rollups only when they add high-value broader context. Output JSON only: {"needs":["id"],"reason":"short reason"}. Use at most 5 valid catalog ids; use an empty array when none is strongly relevant.'
    : '下面的对话摘录仅属于当前对话窗口。请结合最近 3 个已完成的用户—助手回合和当前尚未回答的请求，判断当前主题。仅在大摘要能提供高价值背景时选择它们。只输出 JSON：{"needs":["id"],"reason":"简短理由"}。最多选择 5 个目录中的有效 id；如果没有摘要高度相关，请输出空数组。'
  const decision = await executeStructuredTask({
    task: 'memory_rollup_plan',
    settings,
    messages: [
      { role: 'system', content: instruction },
      { role: 'user', content: `${catalog}\n\n${en ? 'Current-chat conversation excerpt' : '当前对话窗口摘录'}：\n${planningConversation}` }
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

const titleRequests = new Map<string, Promise<{ ok: boolean; title?: string; error?: string }>>()
const TITLE_PRIMARY_BUDGET = 5200
const TITLE_COMPACT_BUDGET = 2600

function normalizedTitleText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/^```(?:text|markdown)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .replace(/^\s*(?:\u6807\u9898|\u9898\u76ee|title)\s*[:\uFF1A\-\u2014]\s*/i, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'\u201C\u201D\u2018\u2019\u300A\u300B\u300C\u300D\u300E\u300F]+|["'\u201C\u201D\u2018\u2019\u300A\u300B\u300C\u300D\u300E\u300F]+$/g, '')
    .trim()
    .replace(/[\u3002\uFF0E.!\uFF01?\uFF1F;\uFF1B:\uFF1A,\uFF0C\u3001]+$/g, '')
    .trim()
}

function compactChineseTitle(value: string): string {
  const chars = Array.from(value)
  if (chars.length <= 20) return value
  const firstClause = value.split(/[\uFF0C,\uFF1A:\uFF1B;\u3002.!\uFF01?\uFF1F\u2014\u2013\-]/, 1)[0]?.trim()
  if (firstClause && Array.from(firstClause).length >= 4 && Array.from(firstClause).length <= 20) return firstClause
  return chars.slice(0, 20).join('').replace(/[\uFF0C,\uFF1A:\uFF1B;\u3002.!\uFF01?\uFF1F\u2014\u2013\-]+$/g, '').trim()
}

function compactEnglishTitle(value: string): string {
  const words = value.split(/\s+/).filter(Boolean)
  if (words.length <= 10) return value
  return words.slice(0, 10).join(' ').replace(/[,:;.!?\u2014\u2013\-]+$/g, '').trim()
}

function parseChatTitle(raw: string, lang: 'zh' | 'en'): string | null {
  let candidate = raw.trim()
  if (candidate.startsWith('{') && candidate.endsWith('}')) {
    try {
      const parsed = JSON.parse(candidate) as { title?: unknown }
      if (typeof parsed.title === 'string') candidate = parsed.title
    } catch {
      // Keep the raw response; the normalizer below will reject malformed wrappers.
    }
  }
  let title = normalizedTitleText(candidate)
  if (!title) return null
  if (/^(?:here(?:'s| is)|sure[,!]?|\u5F53\u7136|\u597D\u7684|\u4EE5\u4E0B\u662F|\u6211\u5EFA\u8BAE|\u5EFA\u8BAE\u6807\u9898)/i.test(title)) return null
  if (/^(?:\u65B0\u5BF9\u8BDD|\u672A\u547D\u540D\u5BF9\u8BDD|\u5173\u4E8E.+(?:\u7684\u8BA8\u8BBA|\u7684\u5BF9\u8BDD)|new chat|untitled chat)$/i.test(title)) return null
  title = lang === 'en' ? compactEnglishTitle(title) : compactChineseTitle(title)
  if (!title || title.length < 2) return null
  if (lang === 'en' && title.split(/\s+/).filter(Boolean).length > 10) return null
  if (lang === 'zh' && Array.from(title).length > 20) return null
  return title
}

function localTitleFallback(turns: ChatMessage[], lang: 'zh' | 'en'): string | null {
  const userMessages = turns.filter((message) => message.role === 'user' && message.content.trim())
  const latest = userMessages[userMessages.length - 1]
  if (!latest) return null
  const attachmentName = latest.attachments
    ?.map((attachment) => cleanAttachmentName(attachment.name, ''))
    .find(Boolean)
  if (attachmentName) {
    const attached = lang === 'en' ? `${attachmentName} Review` : `${attachmentName}\u5185\u5BB9\u5206\u6790`
    return parseChatTitle(attached, lang)
  }

  let candidate = normalizedTitleText(latest.content.split(/[\r\n]/, 1)[0] ?? '')
  if (lang === 'en') {
    candidate = candidate
      .replace(/^(?:please\s+)?(?:help\s+me\s+)?(?:analyze|review|improve|diagnose|discuss|explain|evaluate)\s+/i, '')
      .split(/[.!?;:]/, 1)[0]
      .trim()
    const words = candidate.split(/\s+/).filter(Boolean)
    if (words.length < 2 || words.length > 10) return null
  } else {
    candidate = candidate
      .replace(/^\u8BF7(?:\u4F60)?(?:\u5E2E\u6211)?(?:\u5206\u6790|\u770B\u770B|\u8BC4\u4EF7|\u4F18\u5316|\u8BCA\u65AD|\u8BA8\u8BBA|\u8BF4\u660E|\u89E3\u91CA)?/, '')
      .split(/[\uFF0C,\u3002.!\uFF01?\uFF1F\uFF1B;\uFF1A:]/, 1)[0]
      .trim()
    const length = Array.from(candidate).length
    if (length < 4 || length > 20) return null
  }
  return parseChatTitle(candidate, lang)
}

function titleAttachmentLine(message: ChatMessage, lang: 'zh' | 'en'): string {
  if (!message.attachments?.length) return ''
  const names = message.attachments
    .map((attachment) => cleanAttachmentName(attachment.name, lang === 'en' ? 'unnamed file' : '\u672A\u547D\u540D\u6587\u4EF6'))
    .map((name) => lang === 'en' ? `"${name}"` : `\u300A${name}\u300B`)
  return lang === 'en'
    ? `Attached to this user message: ${names.join(', ')}`
    : `\u6B64\u6761\u7528\u6237\u6D88\u606F\u9644\u6709\uFF1A${names.join('\u3001')}`
}

function titleTurnText(message: ChatMessage, lang: 'zh' | 'en'): string {
  const speaker = message.role === 'user' ? (lang === 'en' ? 'User' : '\u7528\u6237') : 'AI'
  const attachmentLine = message.role === 'user' ? titleAttachmentLine(message, lang) : ''
  return `${speaker}: ${message.content.trim()}${attachmentLine ? `\n${attachmentLine}` : ''}`
}

function selectTitleTurns(turns: ChatMessage[], budget: number): ChatMessage[] {
  if (turns.length <= 4) return turns
  const firstUserIndex = turns.findIndex((message) => message.role === 'user')
  const selected = new Set<number>()
  if (firstUserIndex >= 0) selected.add(firstUserIndex)
  for (let index = Math.max(0, turns.length - 4); index < turns.length; index++) selected.add(index)
  const ordered = [...selected].sort((a, b) => a - b)
  let total = 0
  const kept: number[] = []
  for (const index of [...ordered].reverse()) {
    const length = turns[index].content.length + 80
    if (kept.length > 0 && total + length > budget) continue
    kept.push(index)
    total += length
  }
  if (firstUserIndex >= 0 && !kept.includes(firstUserIndex)) kept.push(firstUserIndex)
  return kept.sort((a, b) => a - b).map((index) => turns[index])
}

function titleContextMetadata(chat: ChatMeta, docTitle: string | undefined, lang: 'zh' | 'en'): string {
  const action = chat.action === 'diagnose'
    ? (lang === 'en' ? 'diagnosis' : '\u8BCA\u65AD')
    : chat.action === 'plot'
      ? (lang === 'en' ? 'plot direction' : '\u8D70\u5411')
      : chat.action === 'optimize'
        ? (lang === 'en' ? 'literary optimization' : '\u4F18\u5316')
        : undefined
  const rows = [
    docTitle ? (lang === 'en' ? `Parent document: "${docTitle}"` : `\u4E0A\u5C5E\u6587\u6863\uFF1A\u300A${docTitle}\u300B`) : '',
    action ? (lang === 'en' ? `Context task: ${action}` : `Context \u5BF9\u8BDD\u4EFB\u52A1\uFF1A${action}`) : ''
  ].filter(Boolean)
  return rows.join('\n')
}

function buildTitleContext(
  turns: ChatMessage[],
  lang: 'zh' | 'en',
  budget: number,
  metadata: string
): string {
  const selected = selectTitleTurns(turns, Math.max(400, budget - metadata.length))
  const sections: string[] = metadata ? [metadata] : []
  let remaining = budget - metadata.length
  for (const message of selected) {
    const rendered = titleTurnText(message, lang)
    if (rendered.length <= remaining) {
      sections.push(rendered)
      remaining -= rendered.length
      continue
    }
    if (sections.length === (metadata ? 1 : 0)) {
      sections.push(Array.from(rendered).slice(0, Math.max(200, remaining)).join(''))
    }
  }
  return sections.join('\n\n')
}

function titleSystemPrompt(lang: 'zh' | 'en', compact: boolean): string {
  if (lang === 'en') {
    return compact
      ? 'Name this writing conversation in 3-8 English words. Output only the title: no quotes, prefix, markdown, numbering, punctuation, or explanation.'
      : 'Generate one consistent, specific title for this writing-assistant conversation. Use a concise noun phrase of 3-8 English words that identifies the actual subject or writing problem. Preserve proper nouns when useful. Output only the title. Do not add quotes, markdown, numbering, a Title: prefix, terminal punctuation, explanations, or generic labels such as New Chat or Discussion About.'
  }
  return compact
    ? '\u8BF7\u75288\u201418\u4E2A\u6C49\u5B57\u4E3A\u8FD9\u6BB5\u5199\u4F5C\u5BF9\u8BDD\u547D\u540D\u3002\u53EA\u8F93\u51FA\u6807\u9898\uFF0C\u4E0D\u52A0\u5F15\u53F7\u3001\u524D\u7F00\u3001Markdown\u3001\u7F16\u53F7\u3001\u53E5\u672B\u6807\u70B9\u6216\u89E3\u91CA\u3002'
    : '\u8BF7\u4E3A\u8FD9\u6BB5\u5199\u4F5C\u52A9\u624B\u5BF9\u8BDD\u751F\u6210\u4E00\u4E2A\u98CE\u683C\u7EDF\u4E00\u3001\u5177\u4F53\u660E\u786E\u7684\u4E2D\u6587\u6807\u9898\u3002\u4F7F\u75288\u201418\u4E2A\u6C49\u5B57\u7684\u7B80\u77ED\u540D\u8BCD\u6027\u6216\u4E3B\u9898\u6027\u77ED\u8BED\uFF0C\u51C6\u786E\u6307\u51FA\u5B9E\u9645\u8BA8\u8BBA\u5BF9\u8C61\u6216\u5199\u4F5C\u95EE\u9898\uFF1B\u5FC5\u8981\u65F6\u4FDD\u7559\u4F5C\u54C1\u540D\u3001\u4EBA\u7269\u540D\u3001\u8BBE\u5B9A\u540D\u7B49\u4E13\u6709\u540D\u8BCD\u3002\u53EA\u8F93\u51FA\u6807\u9898\u672C\u8EAB\uFF0C\u4E0D\u52A0\u5F15\u53F7\u3001Markdown\u3001\u7F16\u53F7\u3001\u201C\u6807\u9898\uFF1A\u201D\u524D\u7F00\u3001\u53E5\u672B\u6807\u70B9\u6216\u89E3\u91CA\uFF1B\u4E0D\u8981\u4F7F\u7528\u201C\u65B0\u5BF9\u8BDD\u201D\u201C\u5173\u4E8E\u67D0\u67D0\u7684\u8BA8\u8BBA\u201D\u7B49\u7A7A\u6CDB\u540D\u79F0\u3002'
}

async function generateChatTitleOnce(chatId: string): Promise<{ ok: boolean; title?: string; error?: string }> {
  const settings = await loadApiSettings()
  if (!settings.apiKey) return { ok: false, error: '\u672A\u914D\u7F6E API Key' }
  const { chat, messages } = await getChat(chatId)
  const turns = messages.filter((message) => message.role === 'user' || message.role === 'assistant')
  if (turns.length === 0) return { ok: false, error: '\u5BF9\u8BDD\u4E3A\u7A7A\uFF0C\u65E0\u6CD5\u751F\u6210\u6807\u9898' }

  let docTitle: string | undefined
  if (chat.docId) {
    try {
      docTitle = (await readDoc(chat.docId)).doc.title
    } catch {
      // The parent document may have been removed; the conversation can still be titled.
    }
  }
  const lang = settings.language
  const metadata = titleContextMetadata(chat, docTitle, lang)
  try {
    const title = await executeStructuredTask<string>({
      task: 'chat_title',
      settings,
      messages: [
        { role: 'system', content: titleSystemPrompt(lang, false) },
        { role: 'user', content: buildTitleContext(turns, lang, TITLE_PRIMARY_BUDGET, metadata) }
      ],
      compactMessages: [
        { role: 'system', content: titleSystemPrompt(lang, true) },
        { role: 'user', content: buildTitleContext(turns, lang, TITLE_COMPACT_BUDGET, metadata) }
      ],
      outputTokens: 96,
      compactOutputTokens: 64,
      outputMode: 'prompt_only',
      maxAttempts: 2,
      parseAndValidate: (raw) => parseChatTitle(raw, lang)
    })
    await renameChat(chatId, title)
    return { ok: true, title }
  } catch (error) {
    const fallback = localTitleFallback(turns, lang)
    if (!fallback) throw error
    await renameChat(chatId, fallback)
    return { ok: true, title: fallback }
  }
}

export async function generateChatTitle(chatId: string): Promise<{ ok: boolean; title?: string; error?: string }> {
  const existing = titleRequests.get(chatId)
  if (existing) return existing
  const request = generateChatTitleOnce(chatId)
    .catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    .finally(() => titleRequests.delete(chatId))
  titleRequests.set(chatId, request)
  return request
}

export async function testConnection(): Promise<ConnectionTestResult> {
  const settings = await loadApiSettings()
  if (!settings.apiKey) return { ok: false, message: '未配置 API Key' }
  try {
    const client = createOpenAIClient(settings.baseURL, settings.apiKey)
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
    const client = createOpenAIClient(baseURL, apiKey)
    const res = await client.models.list()
    const models = (res.data ?? []).map((m) => String(m.id ?? m ?? '')).filter((s) => s.length > 0)
    return { ok: true, models }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
