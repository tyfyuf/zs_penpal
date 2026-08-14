import OpenAI from 'openai'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import type {
  ChatMessage,
  ChatMeta,
  ConnectionTestResult,
  DocSummary,
  StreamContextRange,
  StreamDonePayload,
  StreamRequest
} from '@shared/types'
import { EVENTS } from '@shared/ipc'
import { loadApiSettings } from './api-settings'
import { loadConfig } from './config.service'
import { estimateTokens } from './tokenizer'
import {
  buildChatSummaryBlock,
  buildDocSummaryBlock,
  buildResourceSummaryBlock,
  ensureDocSummary
} from './summary.service'
import { recordUsage } from './usage.service'
import {
  appendMessage,
  buildSnapshot,
  getChat,
  readChatSummary,
  readDoc,
  readDocSummary,
  readResourceSummary,
  readSnapshot,
  renameChat,
  replaceLastAssistantMessage
} from './file.service'
import { newId, nowIso } from '../util'
import { broadcast } from '../window'

// ---------------------------------------------------------------------------
// OpenAI 兼容流式对话（PRD 6.5 / 8.3 / tech-stack 6.6）
// 摘要注入：按对话类型 + 用户配置注入 文档摘要 / 对话摘要 / 资源摘要
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
    arr.reduce((s, m) => s + tok(m.content, model), 0)

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
// 摘要注入
// ---------------------------------------------------------------------------

async function injectSummaries(
  chat: ChatMeta,
  docContent: string | null,
  auxMsgs: ChatCompletionMessageParam[]
): Promise<void> {
  const cfg = await loadConfig()
  if (!cfg.summaryEnabled) return
  const inj = cfg.summaryInjection
  const projectId = chat.projectId
  const tree = (await buildSnapshot()).projects.find((p) => p.project.id === projectId)
  if (!tree) return

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
    let summary: DocSummary | null = null
    if (kind === 'context' && docId === chat.docId && docContent !== null) {
      summary = await ensureDocSummary(projectId, docId, docContent)
    } else {
      summary = await readDocSummary(projectId, docId)
    }
    if (summary) auxMsgs.push({ role: 'system', content: buildDocSummaryBlock(summary) })
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
    const s = await readChatSummary(projectId, chatId)
    if (s && s.items.length > 0) auxMsgs.push({ role: 'system', content: buildChatSummaryBlock(s) })
  }

  // 资源摘要
  const includeResources =
    kind === 'project' ? inj.project.resourceSummaries : kind === 'doc' ? inj.doc.resourceSummaries : inj.context.resourceSummaries
  if (includeResources) {
    for (const r of tree.resources) {
      const s = await readResourceSummary(projectId, r.id)
      if (s) auxMsgs.push({ role: 'system', content: buildResourceSummaryBlock(s, r.name) })
    }
  }
}

// ---------------------------------------------------------------------------
// 组装消息
// ---------------------------------------------------------------------------

async function buildMessages(
  req: StreamRequest,
  chat: ChatMeta,
  history: ChatMessage[],
  appendUser: boolean
): Promise<ChatCompletionMessageParam[]> {
  const cfg = await loadConfig()
  const settings = await loadApiSettings()

  const systemMsgs: ChatCompletionMessageParam[] = [{ role: 'system', content: SYSTEM_PROMPT }]

  // 关联文档上下文（切片 或 全文）
  let docContent: string | null = null
  if (chat.kind === 'context' && chat.docId && req.contextRange) {
    docContent = (await readDoc(req.contextRange.docId)).content
    const slice = sliceContext(docContent, req.contextRange)
    systemMsgs.push({ role: 'system', content: buildContextBlock(slice) })
  } else if (chat.kind === 'doc' && chat.docId && cfg.summaryInjection.doc.fullText) {
    docContent = (await readDoc(chat.docId)).content
    systemMsgs.push({ role: 'system', content: `【关联文档全文】\n${docContent}` })
  }

  // 摘要注入（文档摘要 / 对话摘要 / 资源摘要，按优先级顺序）
  const auxMsgs: ChatCompletionMessageParam[] = []
  await injectSummaries(chat, docContent, auxMsgs)

  // 资源快照（本次上传的文件）
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

  const built = await buildMessages(req, chat, historyForPrompt, !req.regenerate)

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

// ---------------------------------------------------------------------------
// 自动生成对话标题
// ---------------------------------------------------------------------------

export async function generateChatTitle(chatId: string): Promise<{ ok: boolean; title?: string; error?: string }> {
  try {
    const settings = await loadApiSettings()
    if (!settings.apiKey) return { ok: false, error: '未配置 API Key' }
    const { messages } = await getChat(chatId)
    const turns = messages.filter((m) => m.role === 'user' || m.role === 'assistant')
    if (turns.length === 0) return { ok: false, error: '对话为空，无法生成标题' }

    const client = new OpenAI({ baseURL: settings.baseURL, apiKey: settings.apiKey })
    const dialogue = turns
      .map((m) => `${m.role === 'user' ? '用户' : 'AI'}：${m.content}`)
      .join('\n')
      .slice(0, 8000)
    const res = await client.chat.completions.create({
      model: settings.model,
      messages: [
        { role: 'system', content: '请为下面这段写作讨论对话生成一个简短标题（不超过 20 字），只输出标题文本本身。' },
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
    const client = new OpenAI({ baseURL: settings.baseURL, apiKey: settings.apiKey })
    await client.models.list()
    return { ok: true, message: `连接成功（模型：${settings.model}）` }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}
