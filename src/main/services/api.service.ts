import OpenAI from 'openai'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import type {
  AppConfig,
  ChatMessage,
  ChatMeta,
  ConnectionTestResult,
  DocSummary,
  ProjectTree,
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
// 思维链：捕获推理模型的 reasoning_content 并推送给渲染层展示
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

/** 收集该对话当前可注入的候选键（按对话类型与全局注入配置） */
function collectApplicableKeys(chat: ChatMeta, cfg: AppConfig, tree: ProjectTree | undefined): string[] {
  if (!tree) return []
  const kind = chat.kind
  const inj = cfg.summaryInjection
  const keys: string[] = []

  if (kind === 'doc' && inj.doc.fullText) keys.push('fulltext')

  let docIds: string[] = []
  if (kind === 'project' && inj.project.docSummaries) docIds = tree.docs.map((d) => d.id)
  else if (kind === 'doc' && inj.doc.otherDocSummaries) docIds = tree.docs.filter((d) => d.id !== chat.docId).map((d) => d.id)
  else if (kind === 'context' && inj.context.docSummaries) docIds = tree.docs.map((d) => d.id)
  for (const id of docIds) keys.push(`doc:${id}`)

  let chatIds: string[] = []
  if (kind === 'project' && inj.project.chatSummaries) {
    chatIds = tree.chats.filter((c) => c.id !== chat.id).map((c) => c.id)
  } else if (kind === 'doc' && inj.doc.docChatSummaries) {
    chatIds = tree.chats.filter((c) => c.docId === chat.docId && c.id !== chat.id).map((c) => c.id)
  } else if (kind === 'context' && inj.context.docChatSummaries) {
    chatIds = tree.chats.filter((c) => c.docId === chat.docId && c.id !== chat.id).map((c) => c.id)
  }
  for (const id of chatIds) keys.push(`chat:${id}`)

  const includeRes =
    kind === 'project' ? inj.project.resourceSummaries : kind === 'doc' ? inj.doc.resourceSummaries : inj.context.resourceSummaries
  if (includeRes) for (const r of tree.resources) keys.push(`res:${r.id}`)

  return keys
}

/**
 * 计算激活键：对话开始（首条消息）后以冻结的 active 为准（pending 为已开启但尚未随消息使用的键，同样注入）；
 * 此后新加入摘要系统的摘要默认关闭，由用户手动开启。
 */
function computeActiveKeys(chat: ChatMeta, applicable: string[]): Set<string> {
  const frozen = chat.injectionOverrides?.active
  const pending = chat.injectionOverrides?.pending ?? []
  const disabled = chat.injectionOverrides?.disabled ?? []
  const active = new Set<string>()
  for (const k of applicable) {
    if (frozen) {
      if (frozen.includes(k) || pending.includes(k)) active.add(k)
    } else if (!disabled.includes(k)) {
      active.add(k)
    }
  }
  return active
}

async function injectSummaries(
  chat: ChatMeta,
  docContent: string | null,
  tree: ProjectTree | undefined,
  activeKeys: Set<string>
): Promise<{
  docMsgs: ChatCompletionMessageParam[]
  chatMsgs: ChatCompletionMessageParam[]
  resourceMsgs: ChatCompletionMessageParam[]
}> {
  const docMsgs: ChatCompletionMessageParam[] = []
  const chatMsgs: ChatCompletionMessageParam[] = []
  const resourceMsgs: ChatCompletionMessageParam[] = []

  const cfg = await loadConfig()
  if (!cfg.summaryEnabled) return { docMsgs, chatMsgs, resourceMsgs }
  const inj = cfg.summaryInjection
  const projectId = chat.projectId
  if (!tree) return { docMsgs, chatMsgs, resourceMsgs }

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
    if (summary) docMsgs.push({ role: 'system', content: buildDocSummaryBlock(summary) })
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
    if (s && s.items.length > 0) chatMsgs.push({ role: 'system', content: buildChatSummaryBlock(s) })
  }

  // 资源摘要
  const includeResources =
    kind === 'project' ? inj.project.resourceSummaries : kind === 'doc' ? inj.doc.resourceSummaries : inj.context.resourceSummaries
  if (includeResources) {
    for (const r of tree.resources) {
      if (!activeKeys.has(`res:${r.id}`)) continue
      const s = await readResourceSummary(projectId, r.id)
      if (s) resourceMsgs.push({ role: 'system', content: buildResourceSummaryBlock(s, r.name) })
    }
  }

  return { docMsgs, chatMsgs, resourceMsgs }
}

// ---------------------------------------------------------------------------
// 组装消息
// ---------------------------------------------------------------------------

/** 重新生成引导：告知模型用户对上一回答不满意、扩大了上下文/补充了摘要 */
async function buildRegenerateGuidance(
  req: StreamRequest,
  chat: ChatMeta,
  docContent: string | null
): Promise<string | null> {
  const reason = req.regenerateReason
  if (!reason) return null
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
      if (to > from) blocks.push(`【新增上下文·前文】\n${docContent.slice(from, to).slice(0, 4000)}`)
    }
    if (range.after > old.after) {
      const from = Math.min(coreEnd + old.after, n)
      const to = Math.min(coreEnd + range.after, n)
      if (to > from) blocks.push(`【新增上下文·后文】\n${docContent.slice(from, to).slice(0, 4000)}`)
    }
  }

  // 新增摘要
  if ((reason === 'summary' || reason === 'both') && req.newlyEnabledSummaries?.length) {
    for (const key of req.newlyEnabledSummaries) {
      if (key.startsWith('doc:')) {
        const s = await readDocSummary(chat.projectId, key.slice(4))
        if (s) blocks.push(buildDocSummaryBlock(s))
      } else if (key.startsWith('chat:')) {
        const s = await readChatSummary(chat.projectId, key.slice(5))
        if (s && s.items.length > 0) blocks.push(buildChatSummaryBlock(s))
      } else if (key.startsWith('res:')) {
        const resId = key.slice(4)
        const s = await readResourceSummary(chat.projectId, resId)
        if (s) {
          const tree = (await buildSnapshot()).projects.find((p) => p.project.id === chat.projectId)
          const name = tree?.resources.find((r) => r.id === resId)?.name ?? '资源'
          blocks.push(buildResourceSummaryBlock(s, name))
        }
      }
    }
  }

  if (blocks.length === 0) return null

  const intro =
    reason === 'context'
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
): Promise<ChatCompletionMessageParam[]> {
  const cfg = await loadConfig()
  const settings = await loadApiSettings()
  const tree = (await buildSnapshot()).projects.find((p) => p.project.id === chat.projectId)
  const applicable = collectApplicableKeys(chat, cfg, tree)
  const activeKeys = computeActiveKeys(chat, applicable)

  const systemMsgs: ChatCompletionMessageParam[] = [{ role: 'system', content: SYSTEM_PROMPT }]

  // 关联文档上下文（切片 或 全文）
  let docContent: string | null = null
  if (chat.kind === 'context' && chat.docId && req.contextRange) {
    docContent = (await readDoc(req.contextRange.docId)).content
    const slice = sliceContext(docContent, req.contextRange)
    systemMsgs.push({ role: 'system', content: buildContextBlock(slice) })
  } else if (chat.kind === 'doc' && chat.docId) {
    // 文档级对话：读取全文用于触发摘要检测（PRD 7.2），并按配置注入全文
    docContent = (await readDoc(chat.docId)).content
    if (cfg.summaryEnabled) {
      await ensureDocSummary(chat.projectId, chat.docId, docContent)
    }
    if (cfg.summaryInjection.doc.fullText && activeKeys.has('fulltext')) {
      systemMsgs.push({ role: 'system', content: `【关联文档全文】\n${docContent}` })
    }
  }

  // 重新生成引导（扩大范围/补充摘要）
  if (req.regenerate && req.regenerateReason) {
    const guidance = await buildRegenerateGuidance(req, chat, docContent)
    if (guidance) systemMsgs.push({ role: 'system', content: guidance })
  }

  // 摘要注入：文档摘要 > 资源快照 > 对话摘要 > 资源摘要（按优先级排列）
  const { docMsgs, chatMsgs, resourceMsgs } = await injectSummaries(chat, docContent, tree, activeKeys)

  const snapshotMsgs: ChatCompletionMessageParam[] = []
  const snapshotIds = req.snapshotIds ?? lastUserAttachments(history)
  for (const sid of snapshotIds) {
    const snap = await readSnapshot(chat.projectId, chat.id, sid)
    if (snap) {
      snapshotMsgs.push({ role: 'system', content: `【用户上传文件：${snap.name}】\n${snap.content}` })
    }
  }

  const auxMsgs: ChatCompletionMessageParam[] = [...docMsgs, ...snapshotMsgs, ...chatMsgs, ...resourceMsgs]

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
    const attachments = []
    for (const sid of req.snapshotIds ?? []) {
      const snap = await readSnapshot(chat.projectId, chat.id, sid)
      if (snap) attachments.push({ snapshotId: sid, name: snap.name })
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

  let acc = ''
  let reasoning = ''
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
      const choice = chunk.choices?.[0] as
        | { delta?: { content?: string; reasoning_content?: string; reasoning?: string } }
        | undefined
      const deltaText = choice?.delta?.content
      if (deltaText) {
        acc += deltaText
        broadcast(EVENTS.streamChunk, { chatId: req.chatId, requestId: req.requestId, delta: deltaText })
      }
      const rDelta = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning
      if (rDelta) {
        reasoning += rDelta
        broadcast(EVENTS.streamChunk, { chatId: req.chatId, requestId: req.requestId, delta: '', reasoningDelta: rDelta })
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
      reasoning: reasoning || undefined,
      error: (err as Error).message
    })
  } finally {
    controllers.delete(req.requestId)
  }

  // 成功：持久化回答（含思维链）+ 记录用量
  if (!failed && acc.length > 0) {
    if (req.regenerate) {
      await replaceLastAssistantMessage(req.chatId, acc, reasoning || undefined)
    } else {
      await appendMessage(req.chatId, {
        id: newId(),
        role: 'assistant',
        content: acc,
        createdAt: nowIso(),
        reasoning: reasoning || undefined
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

    const client = makeClient(settings.baseURL, settings.apiKey)
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
