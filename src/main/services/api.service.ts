import OpenAI from 'openai'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import type {
  ChatMessage,
  ChatMeta,
  ConnectionTestResult,
  StreamContextRange,
  StreamDonePayload,
  StreamRequest
} from '@shared/types'
import { EVENTS } from '@shared/ipc'
import { loadApiSettings } from './api-settings'
import { loadConfig } from './config.service'
import { estimateTokens } from './tokenizer'
import { ensureDocSummary } from './summary.service'
import { recordUsage } from './usage.service'
import { appendMessage, getChat, readDoc, readSnapshot, replaceLastAssistantMessage } from './file.service'
import { newId, nowIso } from '../util'
import { broadcast } from '../window'

// ---------------------------------------------------------------------------
// OpenAI 兼容流式对话（PRD 6.5 / 8.3 / tech-stack 6.6）
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `你是写作专精辅助 Agent，职责是辅助创作者决策，不替代创作者完成写作成果。
规则：
1. 你不得自动修改用户的写作文档，也不得自动生成、替换或导出成品文件。
2. 你可以在对话中给出诊断、优化文本、改写示例和后续走向建议，表达形式不限。
3. 你的输出只显示在对话区，由用户自行判断并手动复制粘贴。
请用中文回答。`

interface UsageLike {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

const controllers = new Map<string, AbortController>()

export function cancelStream(requestId: string): void {
  controllers.get(requestId)?.abort()
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

function buildContextBlock(slice: ContextSlice): string {
  const parts: string[] = []
  if (slice.beforeText) parts.push(`[前文]\n${slice.beforeText}`)
  if (slice.coreText) parts.push(`[核心内容/选区]\n${slice.coreText}`)
  else parts.push(`[光标位置]`)
  if (slice.afterText) parts.push(`[后文]\n${slice.afterText}`)
  return `【文档上下文】\n${parts.join('\n\n')}`
}

function buildSummaryBlock(s: { coreConflict: string; characterMotivation: string; chapterFunction: string }): string {
  return `【文档摘要】\n- 核心冲突：${s.coreConflict || '（无）'}\n- 角色动机：${s.characterMotivation || '（无）'}\n- 章节功能：${s.chapterFunction || '（无）'}`
}

// ---------------------------------------------------------------------------
// Token 预算（PRD 6.7）
// ---------------------------------------------------------------------------

function tok(content: unknown, model: string): number {
  return estimateTokens(typeof content === 'string' ? content : '', model)
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
      return m.attachments.map((a) => a.snapshotId)
    }
  }
  return []
}

function applyBudget(
  systemMsgs: ChatCompletionMessageParam[],
  auxMsgs: ChatCompletionMessageParam[],
  historyMsgs: ChatCompletionMessageParam[],
  tailMsgs: ChatCompletionMessageParam[],
  model: string,
  contextLimit: number
): ChatCompletionMessageParam[] {
  // 为输出预留约 20% 预算
  const inputBudget = Math.max(1000, Math.floor(contextLimit * 0.8))
  const totalOf = (arr: ChatCompletionMessageParam[]): number =>
    arr.reduce((s, m) => s + tok(m.content, model), 0)

  let h = [...historyMsgs]
  let a = [...auxMsgs]
  let used = totalOf(systemMsgs) + totalOf(a) + totalOf(h) + totalOf(tailMsgs)

  // 优先级从低到高裁剪：历史 → 摘要/快照 → 上下文块
  while (used > inputBudget && h.length) {
    h.shift()
    used = totalOf(systemMsgs) + totalOf(a) + totalOf(h) + totalOf(tailMsgs)
  }
  while (used > inputBudget && a.length) {
    a.shift()
    used = totalOf(systemMsgs) + totalOf(a) + totalOf(h) + totalOf(tailMsgs)
  }
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
// 组装消息
// ---------------------------------------------------------------------------

async function buildMessages(
  req: StreamRequest,
  chat: ChatMeta,
  history: ChatMessage[],
  docContent: string | null,
  appendUser: boolean
): Promise<ChatCompletionMessageParam[]> {
  const cfg = await loadConfig()
  const settings = await loadApiSettings()

  const systemMsgs: ChatCompletionMessageParam[] = [{ role: 'system', content: SYSTEM_PROMPT }]

  // 最高优先级：文档上下文切片
  if (req.contextRange && docContent !== null) {
    const slice = sliceContext(docContent, req.contextRange)
    systemMsgs.push({ role: 'system', content: buildContextBlock(slice) })
  }

  // 摘要（低优先级）
  const auxMsgs: ChatCompletionMessageParam[] = []
  if (req.contextRange && cfg.summaryEnabled && docContent !== null) {
    const summary = await ensureDocSummary(req.contextRange.projectId, req.contextRange.docId, docContent)
    if (summary) auxMsgs.push({ role: 'system', content: buildSummaryBlock(summary) })
  }

  // 资源快照（低优先级）
  const snapshotIds = req.snapshotIds ?? lastUserAttachments(history)
  for (const sid of snapshotIds) {
    const snap = await readSnapshot(chat.projectId, chat.id, sid)
    if (snap) {
      auxMsgs.push({ role: 'system', content: `【用户上传文件：${snap.name}】\n${snap.content}` })
    }
  }

  // 历史
  const historyMsgs: ChatCompletionMessageParam[] = history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

  const tailMsgs: ChatCompletionMessageParam[] = appendUser
    ? [{ role: 'user', content: req.userText }]
    : []

  return applyBudget(systemMsgs, auxMsgs, historyMsgs, tailMsgs, settings.model, settings.contextLimit)
}

// ---------------------------------------------------------------------------
// 流式请求
// ---------------------------------------------------------------------------

export async function streamChat(req: StreamRequest): Promise<void> {
  const settings = await loadApiSettings()
  const { chat, messages } = await getChat(req.chatId)

  let docContent: string | null = null
  if (req.contextRange) {
    docContent = (await readDoc(req.contextRange.docId)).content
  }

  // 组装本次请求的历史与用户消息
  let historyForPrompt: ChatMessage[]
  let userMessage: ChatMessage | null = null

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
    void userMessage
  } else {
    const attachments = []
    for (const sid of req.snapshotIds ?? []) {
      const snap = await readSnapshot(chat.projectId, chat.id, sid)
      if (snap) attachments.push({ snapshotId: sid, name: snap.name })
    }
    userMessage = {
      id: req.userMessageId,
      role: 'user',
      content: req.userText,
      createdAt: nowIso(),
      attachments
    }
    await appendMessage(req.chatId, userMessage)
    historyForPrompt = (await getChat(req.chatId)).messages
  }

  const built = await buildMessages(req, chat, historyForPrompt, docContent, !req.regenerate)

  if (!settings.apiKey) {
    const done: StreamDonePayload = { chatId: req.chatId, requestId: req.requestId, content: '', error: '未配置 API Key，请先在设置中配置' }
    broadcast(EVENTS.streamDone, done)
    return
  }

  const client = new OpenAI({ baseURL: settings.baseURL, apiKey: settings.apiKey })
  const controller = new AbortController()
  controllers.set(req.requestId, controller)

  let acc = ''
  let usage: UsageLike | undefined
  let failed = false

  try {
    const stream = await client.chat.completions.create(
      {
        model: settings.model,
        messages: built,
        stream: true,
        stream_options: { include_usage: true }
      },
      { signal: controller.signal }
    )

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content
      if (delta) {
        acc += delta
        broadcast(EVENTS.streamChunk, { chatId: req.chatId, requestId: req.requestId, delta })
      }
      const u = chunk.usage as UsageLike | undefined
      if (u) usage = u
    }

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
      error: (err as Error).message
    })
  } finally {
    controllers.delete(req.requestId)
  }

  // 成功：持久化回答 + 记录用量
  if (!failed && acc.length > 0) {
    if (req.regenerate) {
      await replaceLastAssistantMessage(req.chatId, acc)
    } else {
      await appendMessage(req.chatId, {
        id: newId(),
        role: 'assistant',
        content: acc,
        createdAt: nowIso()
      })
    }
  }

  if (usage) await recordUsage(usage, 'chat')
  else if (!failed && !controller.signal.aborted) {
    // 响应缺少 usage：标记未计入（PRD 8.5）
    await recordUsage(undefined, 'chat')
  }

  if (!failed) {
    broadcast(EVENTS.streamDone, {
      chatId: req.chatId,
      requestId: req.requestId,
      content: acc,
      usage: usage ? { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, total_tokens: usage.total_tokens } : undefined
    })
  }
}

export async function testConnection(): Promise<ConnectionTestResult> {
  const settings = await loadApiSettings()
  if (!settings.apiKey) return { ok: false, message: '未配置 API Key' }
  try {
    const client = new OpenAI({ baseURL: settings.baseURL, apiKey: settings.apiKey })
    await client.models.list()
    return { ok: true, message: `连接成功（模型：${settings.model}）` }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}
