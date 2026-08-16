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
import { recordUsage } from './usage.service'
import { searchVectorIndex } from './vector.service'
import {
  appendMessage,
  buildSnapshot,
  getChat,
  readChatSummary,
  readDoc,
  readDocRollups,
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
      const s = await readResourceSummary(projectId, r.id)
      if (s) {
        resourceMsgs.push({ role: 'system', content: buildResourceSummaryBlock(s, r.name, lang) })
        items.push({ kind: 'res', key: `res:${r.id}`, title: r.name })
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
        const s = await readResourceSummary(chat.projectId, resId)
        if (s) {
          const tree = (await buildSnapshot()).projects.find((p) => p.project.id === chat.projectId)
          const name = tree?.resources.find((r) => r.id === resId)?.name ?? (en ? 'resource' : '资源')
          blocks.push(buildResourceSummaryBlock(s, name, lang))
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
    docContent = (await readDoc(req.contextRange.docId)).content
    const slice = sliceContext(docContent, req.contextRange)
    systemMsgs.push({ role: 'system', content: buildContextBlock(slice, lang) })
  } else if (chat.kind === 'doc' && chat.docId) {
    // 文档级对话：读取全文用于触发摘要检测（PRD 7.2），并按配置注入全文
    docContent = (await readDoc(chat.docId)).content
    if (cfg.summaryEnabled) {
      await ensureDocSummary(chat.projectId, chat.docId, docContent)
    }
    if (cfg.summaryInjection.doc.fullText && activeKeys.has('fulltext')) {
      systemMsgs.push({ role: 'system', content: `${en ? '【Full text of linked document】' : '【关联文档全文】'}\n${docContent}` })
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
    if (snap) {
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
      snapshotMsgs.push({ role: 'system', content: `${en ? '【Attached document: ' : '【附加文档：'}${doc.title}】\n${content}` })
    } catch {
      /* 文档已删除等，跳过 */
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

  // 记忆规划：模型可自动补充大摘要（B 层）或发起向量检索（C 层），全程透明展示
  let finalMessages = built.messages
  if (!req.regenerate) {
    const cfg = await loadConfig()
    if (cfg.summaryEnabled) {
      const rollups = await readDocRollups(chat.projectId)
      try {
        const plan = await planMemory(client, settings, built.messages, rollups, chat.projectId)
        if (plan.extraMsgs.length > 0) {
          finalMessages = [...finalMessages, ...plan.extraMsgs]
          built.memory.rollups.push(...plan.rollupItems)
          built.memory.vector.push(...plan.vectorItems)
          if (plan.reason) built.memory.reason = plan.reason
        }
      } catch {
        /* 规划失败：不补充记忆，直接作答，绝不卡住用户 */
      }
    }
  }

  let acc = ''
  let reasoning = ''
  let usage: UsageLike | undefined
  let failed = false

  try {
    const stream = await client.chat.completions.create(
      {
        model: settings.model,
        messages: finalMessages,
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
      usage: usage ? { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, total_tokens: usage.total_tokens } : undefined,
      memory: built.memory
    })
  }
}

// ---------------------------------------------------------------------------
// 记忆规划：模型先判断是否需要补充大摘要或发起向量检索（透明展示）
// ---------------------------------------------------------------------------

function parseMemoryPlan(raw: string): { needs: string[]; vectorQuery: string; reason: string } {
  const s = raw.trim().replace(/```(?:json)?/gi, '').trim()
  const attempt = (text: string): { needs: string[]; vectorQuery: string; reason: string } | null => {
    try {
      const p = JSON.parse(text) as { needs?: unknown; vectorQuery?: unknown; reason?: unknown }
      return {
        needs: Array.isArray(p.needs) ? (p.needs as unknown[]).map(String) : [],
        vectorQuery: typeof p.vectorQuery === 'string' ? p.vectorQuery.trim() : '',
        reason: String(p.reason ?? '')
      }
    } catch {
      return null
    }
  }
  return attempt(s) ?? attempt(s.match(/\{[\s\S]*\}/)?.[0] ?? '') ?? { needs: [], vectorQuery: '', reason: '' }
}

async function planMemory(
  client: OpenAI,
  settings: ApiSettings,
  messages: ChatCompletionMessageParam[],
  rollups: DocRollup[],
  projectId: string
): Promise<{
  extraMsgs: ChatCompletionMessageParam[]
  rollupItems: MemoryContextItem[]
  vectorItems: MemoryContextItem[]
  reason: string
}> {
  const en = settings.language === 'en'
  const catalog =
    rollups.length > 0
      ? buildRollupCatalogBlock(rollups, settings.language)
      : en
        ? 'Available document rollups: (none)'
        : '可用的大摘要：无'
  const instruction = en
    ? 'If you need more memory to answer the user, output JSON {"needs": ["id"...], "vectorQuery": "..." or null, "reason": "..."} with at most 5 rollup ids and at most one vectorQuery (a short query to search the project\'s original text chunks; null if not needed). Otherwise output {"needs": [], "vectorQuery": null, "reason": ""}.'
    : '如果你需要更多记忆才能回答用户，输出 JSON {"needs": ["id"...], "vectorQuery": "..." 或 null, "reason": "..."}，needs 最多 5 个 rollup id，vectorQuery 最多一个（用于检索项目原文分块的简短查询，不需要则 null）；否则输出 {"needs": [], "vectorQuery": null, "reason": ""}。'
  const decisionMsgs: ChatCompletionMessageParam[] = [...messages, { role: 'system', content: `${catalog}\n\n${instruction}` }]
  const res = await client.chat.completions.create({
    model: settings.model,
    messages: decisionMsgs,
    temperature: 0,
    max_tokens: 400
  })
  if (res.usage) await recordUsage(res.usage, 'summary')
  const d = parseMemoryPlan(res.choices[0]?.message?.content ?? '')

  const extraMsgs: ChatCompletionMessageParam[] = []
  const rollupItems: MemoryContextItem[] = []
  const vectorItems: MemoryContextItem[] = []

  const byId = new Map(rollups.map((r) => [r.id, r]))
  const label = en ? 'Docs' : '第'
  const suffix = en ? '' : ' 篇'
  for (const id of d.needs.slice(0, 5)) {
    const r = byId.get(id)
    if (!r) continue
    extraMsgs.push({ role: 'system', content: buildRollupBlock(r, settings.language) })
    rollupItems.push({ kind: 'rollup', key: r.id, title: `${label} ${r.rangeLabel}${suffix}`, reason: d.reason })
  }

  if (d.vectorQuery) {
    const hits = await searchVectorIndex(projectId, d.vectorQuery, 5)
    for (const h of hits) {
      extraMsgs.push({ role: 'system', content: `${en ? '【Vector search hit: ' : '【向量检索命中：'}${h.title} #${h.index}】\n${h.text}` })
      vectorItems.push({ kind: 'vector', key: `${h.docId}:${h.index}`, title: `${h.title} #${h.index}`, reason: d.reason })
    }
  }

  return { extraMsgs, rollupItems, vectorItems, reason: d.reason }
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
