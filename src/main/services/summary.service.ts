import OpenAI from 'openai'
import type {
  ChatSummary,
  ChatSummaryItem,
  DistillResult,
  DocSummary,
  GenericResourceSummary,
  ProjectSummariesOverview,
  ResourceSummary,
  StorySummary
} from '@shared/types'
import { loadApiSettings, type ApiSettings } from './api-settings'
import { loadConfig } from './config.service'
import { recordUsage } from './usage.service'
import { estimateTokens } from './tokenizer'
import {
  buildSnapshot,
  getChat,
  readChatSummary,
  readDoc,
  readDocSummary,
  readResource,
  readResourceSummary,
  removeResourceSummary,
  writeChatSummary,
  writeDocSummary,
  writeResourceSummary
} from './file.service'
import { atomicWriteJson, nowIso, readJson } from '../util'
import { join } from 'path'
import { getUserDataDir } from '../paths'
import { EVENTS } from '@shared/ipc'
import { broadcast } from '../window'

// ---------------------------------------------------------------------------
// 摘要生成状态（供摘要区显示“生成中”黄点，生成完毕转绿并解锁）
// ---------------------------------------------------------------------------

const generatingKeys = new Map<string, number>()

export function isSummaryGenerating(key: string): boolean {
  return generatingKeys.has(key)
}

function markGenerating(key: string): void {
  generatingKeys.set(key, Date.now())
  broadcast(EVENTS.summaryStatus, { key, generating: true })
}

function markDone(key: string): void {
  generatingKeys.delete(key)
  broadcast(EVENTS.summaryStatus, { key, generating: false })
}

// ---------------------------------------------------------------------------
// 摘要系统（重写）：
// - 写作文档摘要：故事拆解（结构化故事摘要，见 story-decomposition-guide 简化版）
// - 对话摘要：按顺序逐条生成简短摘要（关闭窗口时批量 + 变化检测）
// - 资源摘要：蒸馏（先分类校验，再按 故事/其他 生成），可取消
// - 全部复用主模型，独立低温度参数，用量打标 source: 'summary'
// ---------------------------------------------------------------------------

const STORY_PROMPT = `你是故事拆解助手。请阅读下面的故事全文，输出一个 JSON 对象（不要输出其他内容），字段如下：
- "overview"：主线剧情总览（一段话，尽量完整）
- "characters"：人物数组，每项含 "name"（名字）、"aliases"（别名数组）、"role"（身份）、"goal"（目标）
- "plot"：按故事顺序的情节点数组，每项含 "id"（如 s1）、"function"（推进/揭示/转折/铺垫/收束）、"summary"（这个情节点发生了什么，尽量具体）
- "foreshadowing"：伏笔数组，每项含 "planted"（埋了什么）、"status"（resolved 或 unresolved）
- "keySettings"：关键设定（字符串数组）
- "keyQuotes"：关键台词（字符串数组）
要求覆盖全文，不要遗漏重要情节。只输出合法 JSON。`

const GENERIC_PROMPT = `你是文本拆解助手。请阅读下面的文本全文，输出一个 JSON 对象（不要输出其他内容），字段如下：
- "docType"：内容类型（如 代码/对话记录/法律条款/表格/叙事/邮件/百科）
- "overview"：内容概述（一段话）
- "keyPoints"：核心要点（字符串数组，按重要性排列）
- "keyTerms"：关键术语/实体（字符串数组）
- "structure"：结构/章节概览
只输出合法 JSON。`

const CLASSIFY_PROMPT = `请判断下面文本的内容类型，输出 JSON（不要输出其他任何内容）：
{ "type": "story" 或 "other", "confidence": 0到1之间的数字, "reasons": ["理由1", "理由2"] }
判定标准（以内容本质为准，排版格式不是依据）：
- "story"：小说、剧本、故事类叙事作品——有人物、有情节推进、有叙事。注意：主要由人物对话构成的对话体故事/剧本也属于 story；标题层级、列表、加粗等格式特征不能作为"other"的理由。
- "other"：信息性/结构化文本——代码、数据列表、报告、邮件、法律条款、百科条目、表格，以及非叙事的聊天记录/会议转写等。
只依据文本内容本质判断，输出必须是合法 JSON。`

const CHAT_PROMPT = `请为下面这段写作讨论对话，按顺序为每条消息生成简短摘要（每条不超过 30 字），输出 JSON 数组，每个元素形如：
[ { "role": "user" 或 "assistant", "summary": "..." } ]
只输出 JSON 数组，不要输出其他内容。`

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function parseJson<T>(raw: string): T | null {
  const s = raw.trim().replace(/```(?:json)?/gi, '').trim()
  try {
    return JSON.parse(s) as T
  } catch {
    /* 继续尝试提取 */
  }
  const arr = s.match(/\[[\s\S]*\]/)
  if (arr) {
    try {
      return JSON.parse(arr[0]) as T
    } catch {
      /* 继续 */
    }
  }
  const obj = s.match(/\{[\s\S]*\}/)
  if (obj) {
    try {
      return JSON.parse(obj[0]) as T
    } catch {
      /* 继续 */
    }
  }
  return null
}

function normalizeStory(parsed: unknown): StorySummary {
  const p = (parsed ?? {}) as Record<string, unknown>
  const chars = Array.isArray(p.characters) ? (p.characters as Record<string, unknown>[]) : []
  const plot = Array.isArray(p.plot) ? (p.plot as Record<string, unknown>[]) : []
  const fs = Array.isArray(p.foreshadowing) ? (p.foreshadowing as Record<string, unknown>[]) : []
  return {
    type: 'story',
    overview: String(p.overview ?? ''),
    characters: chars.map((c) => ({
      name: String(c.name ?? ''),
      aliases: Array.isArray(c.aliases) ? (c.aliases as unknown[]).map(String) : [],
      role: String(c.role ?? ''),
      goal: String(c.goal ?? '')
    })),
    plot: plot.map((pl, i) => ({
      id: String(pl.id ?? `s${i + 1}`),
      function: String(pl.function ?? ''),
      summary: String(pl.summary ?? '')
    })),
    foreshadowing: fs.map((f) => ({
      planted: String(f.planted ?? ''),
      status: f.status === 'resolved' ? ('resolved' as const) : ('unresolved' as const)
    })),
    keySettings: Array.isArray(p.keySettings) ? (p.keySettings as unknown[]).map(String) : [],
    keyQuotes: Array.isArray(p.keyQuotes) ? (p.keyQuotes as unknown[]).map(String) : []
  }
}

function normalizeGeneric(parsed: unknown): GenericResourceSummary {
  const p = (parsed ?? {}) as Record<string, unknown>
  return {
    type: 'other',
    docType: String(p.docType ?? ''),
    overview: String(p.overview ?? ''),
    keyPoints: Array.isArray(p.keyPoints) ? (p.keyPoints as unknown[]).map(String) : [],
    keyTerms: Array.isArray(p.keyTerms) ? (p.keyTerms as unknown[]).map(String) : [],
    structure: String(p.structure ?? '')
  }
}

function makeClient(cfg: ApiSettings): OpenAI {
  return new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey!, timeout: 180000, maxRetries: 0 })
}

// ---------------------------------------------------------------------------
// 字数档位 + Token 预算：优先全文一次调用（与对话上传同等的“看到全文”效果），
// 超出预算直接拒绝并提示调整模型上下文，不再分段合并。
// ---------------------------------------------------------------------------

/** 输入预算：用户配置的模型上下文上限的 60%（其余留给输出与开销） */
function inputBudget(cfg: ApiSettings): number {
  return Math.max(4000, Math.floor(cfg.contextLimit * 0.6))
}

/** 估算输入 token：中文为主模型按 ~1.1 token/字，其余走 tiktoken 映射 */
function estimateInputTokens(content: string, model: string): number {
  const m = model.toLowerCase()
  if (/(deepseek|glm|qwen|kimi|moonshot|yi-|ernie|spark)/.test(m)) {
    return Math.ceil([...content].length * 1.1)
  }
  return estimateTokens(content, model)
}

async function callStoryDecomposition(content: string, cfg: ApiSettings): Promise<StorySummary> {
  const tokens = estimateInputTokens(content, cfg.model)
  const budget = inputBudget(cfg)
  if (tokens > budget) {
    throw new Error('文档超出模型上下文预算（60%），请在设置中调大“模型上下文上限”或更换模型后重试')
  }
  const client = makeClient(cfg)
  const large = content.length > 20000
  const res = await client.chat.completions.create({
    model: cfg.model,
    messages: [
      { role: 'system', content: STORY_PROMPT },
      { role: 'user', content: content || '（空文档）' }
    ],
    temperature: 0.3,
    max_tokens: large ? 8192 : 4096
  })
  if (res.usage) await recordUsage(res.usage, 'summary')
  return normalizeStory(parseJson(res.choices[0]?.message?.content ?? ''))
}

async function callGenericDecomposition(content: string, cfg: ApiSettings): Promise<GenericResourceSummary> {
  const tokens = estimateInputTokens(content, cfg.model)
  const budget = inputBudget(cfg)
  if (tokens > budget) {
    throw new Error('文档超出模型上下文预算（60%），请在设置中调大“模型上下文上限”或更换模型后重试')
  }
  const client = makeClient(cfg)
  const large = content.length > 20000
  const res = await client.chat.completions.create({
    model: cfg.model,
    messages: [
      { role: 'system', content: GENERIC_PROMPT },
      { role: 'user', content: content || '（空内容）' }
    ],
    temperature: 0.3,
    max_tokens: large ? 4096 : 2048
  })
  if (res.usage) await recordUsage(res.usage, 'summary')
  return normalizeGeneric(parseJson(res.choices[0]?.message?.content ?? ''))
}

/** 三段采样：头部/中部/尾部各取一段，避免只看开头导致误判 */
function sampleSections(content: string, per = 2000): string {
  if (content.length <= per * 3) return content
  const head = content.slice(0, per)
  const midStart = Math.floor((content.length - per) / 2)
  const mid = content.slice(midStart, midStart + per)
  const tail = content.slice(-per)
  return `【开头】\n${head}\n\n【中部】\n${mid}\n\n【结尾】\n${tail}`
}

interface ClassifyDecision {
  type: 'story' | 'other'
  confidence: number
  reasons: string[]
}

/**
 * 确定性启发式预筛（零成本）：极保守——仅当另一类信号完全为零时才直接判定，
 * 任何混合信号（如既有对话又有标题层级）一律返回 null 交给模型。
 */
function heuristicClassify(content: string): ClassifyDecision | null {
  const n = Math.max(content.length, 1)
  const per1k = (count: number): number => (count / n) * 1000

  const quoteChars = (content.match(/[“”「」"']/g) ?? []).length
  const chapter = (content.match(/第[0-9一二三四五六七八九十百千零]+[章回节卷]|序章|楔子|尾声|番外|chapter\s*\d+/gi) ?? []).length
  const pronouns = (content.match(/[他她它]/g) ?? []).length
  const dialogue = (content.match(/[：:]\s*["“「]/g) ?? []).length

  const code = (content.match(/\b(function|class|import|export|const|let|var|def|return|typedef|struct|public|private|interface|namespace)\b/g) ?? []).length
  const headings = (content.match(/^#{1,6}\s/gm) ?? []).length
  const tableRows = (content.match(/^\|/gm) ?? []).length
  const urls = (content.match(/https?:\/\/|www\.|\b[\w.+-]+@[\w-]+\.[\w.]+\b/g) ?? []).length
  const digits = content.replace(/\D/g, '').length

  const storyFlags: string[] = []
  if (per1k(quoteChars) >= 6) storyFlags.push('对话引号密度高')
  if (chapter > 0) storyFlags.push('存在章节标题')
  if (per1k(pronouns) >= 10) storyFlags.push('人物指代密度高')
  if (dialogue > 0) storyFlags.push('存在对话段落')

  const otherFlags: string[] = []
  if (code > 0) otherFlags.push('存在代码特征')
  if (headings > 0) otherFlags.push('存在标题层级')
  if (tableRows > 0) otherFlags.push('存在表格')
  if (urls > 0) otherFlags.push('存在链接/邮箱')
  if (per1k(digits) >= 30) otherFlags.push('数字密度高')

  const storyScore = per1k(quoteChars) * 2 + chapter * 5 + per1k(pronouns) * 1.5 + dialogue * 3
  const otherScore = code * 6 + headings * 4 + tableRows * 2 + urls * 4 + per1k(digits) * 1.5

  // 极保守：仅当另一类信号完全为零时才直接判定
  if (storyScore >= 6 && otherFlags.length === 0) {
    return { type: 'story', confidence: 0.95, reasons: storyFlags.length ? storyFlags : ['叙事文本特征明显'] }
  }
  if (otherScore >= 6 && storyFlags.length === 0) {
    return { type: 'other', confidence: 0.95, reasons: otherFlags.length ? otherFlags : ['结构化文本特征明显'] }
  }
  return null
}

/** 模型结构化判定：三段采样 + JSON 输出（含置信度与理由） */
async function classifyByLlm(content: string, cfg: ApiSettings): Promise<ClassifyDecision | null> {
  const client = makeClient(cfg)
  const res = await client.chat.completions.create({
    model: cfg.model,
    messages: [
      { role: 'system', content: CLASSIFY_PROMPT },
      { role: 'user', content: sampleSections(content) }
    ],
    temperature: 0,
    max_tokens: 256
  })
  if (res.usage) await recordUsage(res.usage, 'summary')
  const parsed = parseJson<{ type?: string; confidence?: number; reasons?: unknown[] }>(
    res.choices[0]?.message?.content ?? ''
  )
  if (!parsed) return null
  const type: 'story' | 'other' = String(parsed.type ?? '').toLowerCase().includes('story') ? 'story' : 'other'
  const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0
  const reasons = Array.isArray(parsed.reasons) ? (parsed.reasons as unknown[]).map(String) : []
  return { type, confidence, reasons }
}

// ---------------------------------------------------------------------------
// 文档摘要（故事拆解）
// ---------------------------------------------------------------------------

/** 估算“增删改字符总量”（行级差异 + 长度差，PRD 7.2 触发条件） */
export function estimateChangedChars(prev: string, curr: string): number {
  if (prev === curr) return 0
  const a = prev.split('\n')
  const b = curr.split('\n')
  const setA = new Set(a)
  const setB = new Set(b)
  let changed = 0
  for (const l of a) if (!setB.has(l)) changed += l.length + 1
  for (const l of b) if (!setA.has(l)) changed += l.length + 1
  return changed + Math.abs(prev.length - curr.length)
}

async function generateDocSummary(projectId: string, docId: string, content: string, cfg: ApiSettings): Promise<DocSummary> {
  void projectId
  void docId
  const story = await callStoryDecomposition(content, cfg)
  return { ...story, snapshotLength: content.length, snapshot: content, updatedAt: nowIso() }
}

/**
 * 静默检测关联文档摘要是否需要更新（PRD 7.2），返回本次请求应附加的摘要。
 * 方案 a：首次请求时阻塞生成（由调用方显示“正在生成摘要”）。
 */
export async function ensureDocSummary(projectId: string, docId: string, currentContent: string): Promise<DocSummary | null> {
  const cfg = await loadConfig()
  if (!cfg.summaryEnabled) return null
  const settings = await loadApiSettings()
  if (!settings.apiKey) return null

  const existing = await readDocSummary(projectId, docId)
  if (!existing) {
    const key = `doc:${docId}`
    markGenerating(key)
    try {
      const summary = await generateDocSummary(projectId, docId, currentContent, settings)
      await writeDocSummary(projectId, docId, summary)
      return summary
    } catch {
      return null
    } finally {
      markDone(key)
    }
  }

  const changed = estimateChangedChars(existing.snapshot ?? '', currentContent)
  const netAdded = Math.max(0, currentContent.length - (existing.snapshot?.length ?? 0))
  const needUpdate = changed / Math.max(existing.snapshotLength, 1) > 0.3 || netAdded > 500
  if (!needUpdate) return existing

  const key = `doc:${docId}`
  markGenerating(key)
  try {
    const summary = await generateDocSummary(projectId, docId, currentContent, settings)
    await writeDocSummary(projectId, docId, summary)
    return summary
  } catch {
    return existing
  } finally {
    markDone(key)
  }
}

/** 手动重新生成文档摘要（摘要区入口） */
export async function regenerateDocSummary(docId: string): Promise<{ ok: boolean; error?: string }> {
  const key = `doc:${docId}`
  markGenerating(key)
  try {
    const cfg = await loadConfig()
    if (!cfg.summaryEnabled) return { ok: false, error: '摘要功能未开启' }
    const settings = await loadApiSettings()
    if (!settings.apiKey) return { ok: false, error: '未配置 API Key' }
    const { doc, content } = await readDoc(docId)
    const summary = await generateDocSummary(doc.projectId, docId, content, settings)
    await writeDocSummary(doc.projectId, docId, summary)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  } finally {
    markDone(key)
  }
}

// ---------------------------------------------------------------------------
// 对话摘要（逐条 + 变化检测）
// ---------------------------------------------------------------------------

let queue: Promise<unknown> = Promise.resolve()
const pendingRetry = new Set<string>()

function retryFilePath(): string {
  return join(getUserDataDir(), 'summary-retry.json')
}

export async function loadRetryState(): Promise<string[]> {
  const data = await readJson<{ chatIds: string[] }>(retryFilePath())
  return data?.chatIds ?? []
}

async function persistRetry(): Promise<void> {
  await atomicWriteJson(retryFilePath(), { chatIds: [...pendingRetry] })
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.catch(() => {})
  return run
}

async function generateChatSummary(chatId: string, force = false): Promise<void> {
  const cfg = await loadApiSettings()
  if (!cfg.apiKey) throw new Error('未配置 API Key')

  const { chat, messages } = await getChat(chatId)
  const turns = messages.filter((m) => m.role === 'user' || m.role === 'assistant')
  if (turns.length === 0) return

  const lastMessageId = turns[turns.length - 1].id
  const messageCount = turns.length
  const existing = await readChatSummary(chat.projectId, chatId)
  // 变化检测：无变化则不调用（手动重新生成时强制跳过）
  if (!force && existing && existing.lastMessageId === lastMessageId && existing.messageCount === messageCount) return

  const key = `chat:${chatId}`
  markGenerating(key)
  try {
    const client = makeClient(cfg)
    const dialogue = turns
      .map((m, i) => `${i + 1}. ${m.role === 'user' ? '用户' : 'AI'}：${m.content}`)
      .join('\n')
      .slice(0, 12000)
    const res = await client.chat.completions.create({
      model: cfg.model,
      messages: [
        { role: 'system', content: CHAT_PROMPT },
        { role: 'user', content: dialogue }
      ],
      temperature: 0.3,
      max_tokens: 2048
    })
    if (res.usage) await recordUsage(res.usage, 'summary')

    const parsed = parseJson<{ role: string; summary: string }[]>(res.choices[0]?.message?.content ?? '')
    // 与消息一一对应（以真实消息角色为准，按位置对齐；不足补空、多余丢弃）
    const rawItems = Array.isArray(parsed) ? parsed : []
    const items: ChatSummaryItem[] = turns.map((t, i) => ({
      messageId: t.id,
      role: t.role === 'user' ? ('user' as const) : ('assistant' as const),
      summary: rawItems[i] ? String(rawItems[i].summary ?? '') : ''
    }))
    await writeChatSummary(chat.projectId, chatId, { items, updatedAt: nowIso(), lastMessageId, messageCount })
  } finally {
    markDone(key)
  }
}

/** 关闭对话窗口后入队生成对话摘要（PRD 7.5）；force 用于手动重新生成 */
export function queueChatSummary(chatId: string, force = false): Promise<void> {
  return enqueue(async () => {
    try {
      await generateChatSummary(chatId, force)
      pendingRetry.delete(chatId)
      await persistRetry()
    } catch {
      pendingRetry.add(chatId)
      await persistRetry()
    }
  })
}

/** 手动重新生成对话摘要（摘要区按钮） */
export async function regenerateChatSummary(chatId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const cfg = await loadConfig()
    if (!cfg.summaryEnabled) return { ok: false, error: '摘要功能未开启' }
    await queueChatSummary(chatId, true)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export async function retryPendingSummaries(): Promise<void> {
  const ids = await loadRetryState()
  for (const id of ids) {
    if (id) await queueChatSummary(id)
  }
}

/** 退出时等待摘要队列；超时返回 false（PRD 7.5） */
export async function waitForSummaryQueue(timeoutMs: number): Promise<boolean> {
  const timeout = new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs))
  const done = queue.then(() => true)
  return Promise.race([done, timeout])
}

// ---------------------------------------------------------------------------
// 资源蒸馏
// ---------------------------------------------------------------------------

export async function distillResource(
  projectId: string,
  resourceId: string,
  type: 'story' | 'other',
  force = false
): Promise<DistillResult> {
  const key = `res:${resourceId}`
  markGenerating(key)
  try {
    return await distillResourceInner(projectId, resourceId, type, force)
  } finally {
    markDone(key)
  }
}

async function distillResourceInner(
  projectId: string,
  resourceId: string,
  type: 'story' | 'other',
  force: boolean
): Promise<DistillResult> {
  const cfg = await loadConfig()
  if (!cfg.summaryEnabled) return { ok: false, error: '摘要功能未开启' }
  const settings = await loadApiSettings()
  if (!settings.apiKey) return { ok: false, error: '未配置 API Key' }

  let content: string
  try {
    content = (await readResource(projectId, resourceId)).content
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
  if (!content.trim()) return { ok: false, error: '资源内容为空' }

  // 类型判定（force 时跳过，直接按用户所选类型生成）
  if (!force) {
    // 1. 启发式预筛（零成本，强信号直接判定）
    let decision: ClassifyDecision | null = heuristicClassify(content)

    // 2. 弱信号 → 模型结构化判定（三段采样）
    if (!decision) {
      try {
        decision = await classifyByLlm(content, settings)
      } catch {
        return { ok: false, error: '类型判定失败，请重试' }
      }
      if (!decision) {
        return { ok: false, error: '类型判定失败，请重试' }
      }
    }

    // 3. 置信度兜底：< 0.8 → 让用户确认
    if (decision.confidence < 0.8) {
      return { ok: false, uncertain: true, detectedType: decision.type, reasons: decision.reasons }
    }

    // 4. 与所选不符 → 提示重新选择
    if (decision.type !== type) {
      return { ok: false, mismatch: true, detectedType: decision.type, reasons: decision.reasons }
    }
  }

  // 生成对应摘要
  try {
    const summary: ResourceSummary =
      type === 'story'
        ? { ...(await callStoryDecomposition(content, settings)), updatedAt: nowIso() }
        : { ...(await callGenericDecomposition(content, settings)), updatedAt: nowIso() }
    await writeResourceSummary(projectId, resourceId, summary)
    return { ok: true, summary, detectedType: type }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export async function undistillResource(projectId: string, resourceId: string): Promise<void> {
  await removeResourceSummary(projectId, resourceId)
}

export async function listProjectSummaries(projectId: string): Promise<ProjectSummariesOverview> {
  const snap = await buildSnapshot()
  const tree = snap.projects.find((p) => p.project.id === projectId)
  if (!tree) return { docs: [], chats: [], resources: [] }

  const docs = await Promise.all(
    tree.docs.map(async (d) => {
      const s = await readDocSummary(projectId, d.id)
      return {
        docId: d.id,
        title: d.title,
        hasSummary: !!s,
        updatedAt: s?.updatedAt,
        generating: isSummaryGenerating(`doc:${d.id}`)
      }
    })
  )
  const chats = await Promise.all(
    tree.chats.map(async (c) => {
      const s = await readChatSummary(projectId, c.id)
      return {
        chatId: c.id,
        title: c.title,
        hasSummary: !!s,
        updatedAt: s?.updatedAt,
        docId: c.docId,
        kind: c.kind,
        generating: isSummaryGenerating(`chat:${c.id}`)
      }
    })
  )
  const resources = await Promise.all(
    tree.resources.map(async (r) => {
      const s = await readResourceSummary(projectId, r.id)
      const generating = isSummaryGenerating(`res:${r.id}`)
      return { resourceId: r.id, name: r.name, distilled: !!s, type: s?.type, updatedAt: s?.updatedAt, generating }
    })
  )
  // 资源区只展示已蒸馏或正在蒸馏的资源（未蒸馏且未生成的隐藏，避免堆积）
  return { docs, chats, resources: resources.filter((r) => r.distilled || r.generating) }
}

// ---------------------------------------------------------------------------
// 摘要 → prompt 格式化
// ---------------------------------------------------------------------------

function storyBlock(s: StorySummary): string {
  const chars = (Array.isArray(s.characters) ? s.characters : [])
    .map((c) => `- ${c.name}${c.aliases.length ? `（${c.aliases.join('、')}）` : ''}：${c.role}${c.goal ? ` · 目标：${c.goal}` : ''}`)
    .join('\n')
  const plot = (Array.isArray(s.plot) ? s.plot : []).map((p) => `- ${p.id}｜${p.function}：${p.summary}`).join('\n')
  const fs = (Array.isArray(s.foreshadowing) ? s.foreshadowing : []).map((f) => `- ${f.planted}（${f.status === 'resolved' ? '已回收' : '未回收'}）`).join('\n')
  const settings = Array.isArray(s.keySettings) ? s.keySettings : []
  const quotes = Array.isArray(s.keyQuotes) ? s.keyQuotes : []
  return `总览：${s.overview || '（无）'}\n\n人物：\n${chars || '（无）'}\n\n情节链：\n${plot || '（无）'}\n\n伏笔：\n${fs || '（无）'}\n\n关键设定：${settings.join('、') || '（无）'}\n关键台词：${quotes.join(' / ') || '（无）'}`
}

export function buildDocSummaryBlock(s: DocSummary): string {
  return `【文档摘要】\n${storyBlock(s)}`
}

export function buildChatSummaryBlock(s: ChatSummary): string {
  const lines = (Array.isArray(s.items) ? s.items : [])
    .map((i) => `${i.role === 'user' ? '用户' : 'AI'}：${i.summary}`)
    .join('\n')
  return `【对话摘要】\n${lines || '（无）'}`
}

export function buildResourceSummaryBlock(s: ResourceSummary, name: string): string {
  if (s.type === 'story') {
    return `【资源摘要：${name}】\n${storyBlock(s)}`
  }
  const keyPoints = Array.isArray(s.keyPoints) ? s.keyPoints : []
  const keyTerms = Array.isArray(s.keyTerms) ? s.keyTerms : []
  return `【资源摘要：${name}】\n类型：${s.docType || '未知'}\n概述：${s.overview || '（无）'}\n要点：\n${keyPoints.map((p) => `- ${p}`).join('\n') || '（无）'}\n术语：${keyTerms.join('、') || '（无）'}\n结构：${s.structure || '（无）'}`
}
