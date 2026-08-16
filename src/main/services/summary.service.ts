import OpenAI from 'openai'
import type {
  ChatSummary,
  ChatSummaryItem,
  DistillResult,
  DocRollup,
  DocRollupOverview,
  DocSummary,
  GenericResourceSummary,
  ProjectSummariesOverview,
  ResourceSummary,
  StorySummary,
  SummarySearchResult
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
  readDocRollups,
  readDocSummary,
  readResource,
  readResourceSummary,
  removeResourceSummary,
  writeChatSummary,
  writeDocRollups,
  writeDocSummary,
  writeResourceSummary
} from './file.service'
import { atomicWriteJson, nowIso, readJson } from '../util'
import { join } from 'path'
import { getUserDataDir } from '../paths'
import { computeSourceInfo, isSourceStale, SUMMARY_SCHEMA_VERSION } from '../summary-source'
import { computeDefaultActive } from '../summary-relevance'
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

type Lang = 'zh' | 'en'

function storyPrompt(lang: Lang): string {
  return lang === 'en'
    ? `You are a story decomposition assistant. Read the full story below and output EXACTLY ONE JSON object (nothing else — no code fences, no prose), with these fields:
- "overview": the main plot in one paragraph, at most 200 words, as complete as possible
- "characters": array of characters, each with "name", "aliases" (array; empty if none), "role", "goal" (empty string if none)
- "plot": array of plot points in story order, each with "id" (e.g. "s1"), "function" (exactly one of: advance/reveal/turn/foreshadow/resolve), "summary" (what happens, at most 80 words, be specific)
- "foreshadowing": array, each with "planted" (what was set up) and "status" (exactly "resolved" or "unresolved")
- "keySettings": array of key settings, each at most 40 words
- "keyQuotes": array of key quotes
Cover the entire text and do not omit important plot points. Leave a field empty ([] or "") when the information is absent — DO NOT invent. All content in English. Output valid JSON only.`
    : `你是故事拆解助手。请阅读下面的故事全文，输出恰好一个 JSON 对象（不要输出 JSON 以外的任何内容，不要用代码块包裹），字段如下：
- "overview"：主线剧情总览，一段话，不超过 200 字，尽量完整
- "characters"：人物数组，每项含 "name"（名字）、"aliases"（别名数组，无则空数组）、"role"（身份）、"goal"（目标，无则空字符串）
- "plot"：按故事顺序的情节点数组，每项含 "id"（如 s1）、"function"（只能取：推进/揭示/转折/铺垫/收束）、"summary"（这个情节点发生了什么，每点不超过 80 字，尽量具体）
- "foreshadowing"：伏笔数组，每项含 "planted"（埋了什么）、"status"（只能取 resolved 或 unresolved）
- "keySettings"：关键设定，字符串数组，每条不超过 40 字
- "keyQuotes"：关键台词，字符串数组
要求覆盖全文、不遗漏重要情节；信息不足的字段留空数组或空字符串，禁止编造。只输出合法 JSON。`
}

function genericPrompt(lang: Lang): string {
  return lang === 'en'
    ? `You are a text decomposition assistant. Read the full text below and output EXACTLY ONE JSON object (nothing else — no code fences, no prose), with these fields:
- "docType": the content type (one of: code/transcript/legal/table/narrative/email/encyclopedia/data/reference)
- "overview": a summary of the content, one paragraph, at most 200 words
- "keyPoints": key points, array of strings ordered by importance, each at most 80 words
- "keyTerms": key terms/entities, array of strings, each at most 40 words
- "structure": an overview of the structure/sections, at most 200 words
Leave a field empty ([] or "") when absent — DO NOT invent. All content in English. Output valid JSON only.`
    : `你是文本拆解助手。请阅读下面的文本全文，输出恰好一个 JSON 对象（不要输出 JSON 以外的任何内容，不要用代码块包裹），字段如下：
- "docType"：内容类型（只能取：代码/对话记录/法律条款/表格/叙事/邮件/百科/数据/参考）
- "overview"：内容概述，一段话，不超过 200 字
- "keyPoints"：核心要点，字符串数组，按重要性排列，每条不超过 80 字
- "keyTerms"：关键术语/实体，字符串数组，每条不超过 40 字
- "structure"：结构/章节概览，不超过 200 字
信息不足的字段留空数组或空字符串，禁止编造。只输出合法 JSON。`
}

function classifyPrompt(lang: Lang): string {
  return lang === 'en'
    ? `Classify the content type of the text below and output JSON (nothing else):
{ "type": "story" or "other", "confidence": a number from 0 to 1, "reasons": ["reason1", "reason2"] }
Criteria (judge by the nature of the content, not formatting):
- "story": novels, scripts, narrative works with characters, plot progression. Dialogue-driven stories/scripts also count as story. Headings, lists, bold text are not evidence for "other".
- "other": informational/structured text — code, data lists, reports, emails, legal text, encyclopedia entries, tables, and non-narrative chat logs/meeting transcripts.
Write the reasons in English. Output valid JSON only.`
    : `请判断下面文本的内容类型，输出 JSON（不要输出其他任何内容）：
{ "type": "story" 或 "other", "confidence": 0到1之间的数字, "reasons": ["理由1", "理由2"] }
判定标准（以内容本质为准，排版格式不是依据）：
- "story"：小说、剧本、故事类叙事作品——有人物、有情节推进、有叙事。注意：主要由人物对话构成的对话体故事/剧本也属于 story；标题层级、列表、加粗等格式特征不能作为"other"的理由。
- "other"：信息性/结构化文本——代码、数据列表、报告、邮件、法律条款、百科条目、表格，以及非叙事的聊天记录/会议转写等。
只依据文本内容本质判断，输出必须是合法 JSON。`
}

function chatPrompt(lang: Lang): string {
  return lang === 'en'
    ? `For each message in the conversation below, write a short summary (max 30 words per message) in order. Output a JSON array where each element looks like:
[ { "role": "user" or "assistant", "summary": "..." } ]
Write all summaries in English. Output only the JSON array.`
    : `请为下面这段写作讨论对话，按顺序为每条消息生成简短摘要（每条不超过 30 字），输出 JSON 数组，每个元素形如：
[ { "role": "user" 或 "assistant", "summary": "..." } ]
只输出 JSON 数组，不要输出其他内容。`
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 稳健 JSON 解析：支持代码块包裹、截断抢救（取最后一个配平位置） */
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
  // 对象：从第一个 { 开始，找到最后一个配平的位置（截断抢救）
  const start = s.indexOf('{')
  if (start >= 0) {
    let depth = 0
    let inStr = false
    let esc = false
    let lastBalanced = -1
    for (let i = start; i < s.length; i++) {
      const ch = s[i]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') {
        inStr = true
        continue
      }
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          lastBalanced = i
          break
        }
      }
    }
    if (lastBalanced > start) {
      try {
        return JSON.parse(s.slice(start, lastBalanced + 1)) as T
      } catch {
        /* 继续 */
      }
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
// 全局 LLM 调用串行队列：摘要/蒸馏/分类共用并发 1，避免并发请求互相堵塞
// ---------------------------------------------------------------------------

let llmQueue: Promise<unknown> = Promise.resolve()

function enqueueLlm<T>(task: () => Promise<T>): Promise<T> {
  const run = llmQueue.then(task, task)
  llmQueue = run.catch(() => {})
  return run
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

function isStoryEmpty(s: StorySummary): boolean {
  return !s.overview.trim() && s.characters.length === 0 && s.plot.length === 0
}

function isGenericEmpty(g: GenericResourceSummary): boolean {
  return !g.overview.trim() && g.keyPoints.length === 0
}

async function callStoryDecomposition(content: string, cfg: ApiSettings): Promise<StorySummary> {
  const tokens = estimateInputTokens(content, cfg.model)
  const budget = inputBudget(cfg)
  if (tokens > budget) {
    throw new Error('文档超出模型上下文预算（60%），请在设置中调大“模型上下文上限”或更换模型后重试')
  }
  return enqueueLlm(async () => {
    const client = makeClient(cfg)
    const large = content.length > 20000
    // 空结果 / 输出被截断时自动重试一次
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await client.chat.completions.create({
        model: cfg.model,
        messages: [
          { role: 'system', content: storyPrompt(cfg.language) },
          { role: 'user', content: content || (cfg.language === 'en' ? '(empty document)' : '（空文档）') }
        ],
        temperature: 0.3,
        max_tokens: large ? 8192 : 4096
      })
      if (res.usage) await recordUsage(res.usage, 'summary')
      const summary = normalizeStory(parseJson(res.choices[0]?.message?.content ?? ''))
      const truncated = res.choices[0]?.finish_reason === 'length'
      if (!truncated && !isStoryEmpty(summary)) return summary
    }
    throw new Error('摘要生成不完整（内容为空或被截断），请重试')
  })
}

async function callGenericDecomposition(content: string, cfg: ApiSettings): Promise<GenericResourceSummary> {
  const tokens = estimateInputTokens(content, cfg.model)
  const budget = inputBudget(cfg)
  if (tokens > budget) {
    throw new Error('文档超出模型上下文预算（60%），请在设置中调大“模型上下文上限”或更换模型后重试')
  }
  return enqueueLlm(async () => {
    const client = makeClient(cfg)
    const large = content.length > 20000
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await client.chat.completions.create({
        model: cfg.model,
        messages: [
          { role: 'system', content: genericPrompt(cfg.language) },
          { role: 'user', content: content || (cfg.language === 'en' ? '(empty content)' : '（空内容）') }
        ],
        temperature: 0.3,
        max_tokens: large ? 4096 : 2048
      })
      if (res.usage) await recordUsage(res.usage, 'summary')
      const summary = normalizeGeneric(parseJson(res.choices[0]?.message?.content ?? ''))
      const truncated = res.choices[0]?.finish_reason === 'length'
      if (!truncated && !isGenericEmpty(summary)) return summary
    }
    throw new Error('摘要生成不完整（内容为空或被截断），请重试')
  })
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
  return enqueueLlm(async () => {
    const client = makeClient(cfg)
    const res = await client.chat.completions.create({
      model: cfg.model,
      messages: [
        { role: 'system', content: classifyPrompt(cfg.language) },
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
  })
}

// ---------------------------------------------------------------------------
// 文档摘要（故事拆解）
// ---------------------------------------------------------------------------

/** 估算“增删改字符总量”（行级差异 + 长度差）；已由源指纹失效检测取代，保留仅供参考 */
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
  return { ...story, ...computeSourceInfo(content), updatedAt: nowIso() }
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

  if (!isSourceStale(existing, currentContent)) return existing

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
        { role: 'system', content: chatPrompt(cfg.language) },
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
    await writeChatSummary(chat.projectId, chatId, {
      schemaVersion: SUMMARY_SCHEMA_VERSION,
      items,
      updatedAt: nowIso(),
      lastMessageId,
      messageCount
    })
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
        ? { ...(await callStoryDecomposition(content, settings)), ...computeSourceInfo(content), updatedAt: nowIso() }
        : { ...(await callGenericDecomposition(content, settings)), ...computeSourceInfo(content), updatedAt: nowIso() }
    await writeResourceSummary(projectId, resourceId, summary)
    return { ok: true, summary, detectedType: type }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export async function undistillResource(projectId: string, resourceId: string): Promise<void> {
  await removeResourceSummary(projectId, resourceId)
}

/** 读时惰性检测资源摘要是否过期；旧摘要无指纹则用当前内容补算落盘（视为新鲜，此后可检测） */
export async function checkResourceSummaryStale(projectId: string, resourceId: string): Promise<boolean> {
  const s = await readResourceSummary(projectId, resourceId)
  if (!s) return false
  try {
    const { content } = await readResource(projectId, resourceId)
    if (!s.sourceFingerprint) {
      const patched: ResourceSummary = { ...s, ...computeSourceInfo(content) }
      await writeResourceSummary(projectId, resourceId, patched)
      return false
    }
    return isSourceStale(s, content)
  } catch {
    return false
  }
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
      const stale = s ? await checkResourceSummaryStale(projectId, r.id) : false
      return { resourceId: r.id, name: r.name, distilled: !!s, type: s?.type, updatedAt: s?.updatedAt, generating, stale }
    })
  )
  // 资源区只展示已蒸馏或正在蒸馏的资源（未蒸馏且未生成的隐藏，避免堆积）
  return { docs, chats, resources: resources.filter((r) => r.distilled || r.generating) }
}

/** 该对话当前默认激活的注入键（相关度采样，供渲染层展示默认开启项并在首条消息冻结） */
export async function getDefaultActiveKeys(chatId: string): Promise<string[]> {
  const { chat } = await getChat(chatId)
  const cfg = await loadConfig()
  const tree = (await buildSnapshot()).projects.find((p) => p.project.id === chat.projectId)
  return computeDefaultActive(chat, tree, cfg)
}

/** 摘要可检索文本（零 LLM，供搜索匹配） */
function summarySearchText(s: ResourceSummary | DocSummary | ChatSummary | null): string {
  if (!s) return ''
  if ('items' in s && Array.isArray(s.items)) {
    return s.items.map((i) => i.summary).join(' ')
  }
  const parts: string[] = []
  const o = s as unknown as Record<string, unknown>
  parts.push(String(o.overview ?? ''))
  for (const key of ['keyPoints', 'keyTerms', 'keySettings', 'keyQuotes']) {
    if (Array.isArray(o[key])) parts.push((o[key] as unknown[]).map(String).join(' '))
  }
  if (Array.isArray(o.characters)) {
    for (const c of o.characters as Record<string, unknown>[]) {
      parts.push(String(c.name ?? ''), Array.isArray(c.aliases) ? (c.aliases as unknown[]).map(String).join(' ') : '', String(c.role ?? ''))
    }
  }
  if (Array.isArray(o.plot)) parts.push((o.plot as Record<string, unknown>[]).map((p) => String(p.summary ?? '')).join(' '))
  return parts.join(' ')
}

/** 在项目内搜索摘要（标题 + 摘要文本子串匹配，大小写不敏感），用于注入搜索框手动激活 */
export async function searchProjectSummaries(projectId: string, query: string): Promise<SummarySearchResult[]> {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const snap = await buildSnapshot()
  const tree = snap.projects.find((p) => p.project.id === projectId)
  if (!tree) return []

  const results: SummarySearchResult[] = []
  const hit = (title: string, text: string): boolean => title.toLowerCase().includes(q) || text.toLowerCase().includes(q)
  const push = (key: string, kind: 'doc' | 'chat' | 'res', title: string, s: ResourceSummary | DocSummary | ChatSummary | null): void => {
    const text = summarySearchText(s)
    if (!hit(title, text)) return
    const preview = text.slice(0, 80)
    results.push({ key, kind, title, preview, updatedAt: (s as { updatedAt?: string } | null)?.updatedAt })
  }

  for (const d of tree.docs) push(`doc:${d.id}`, 'doc', d.title, await readDocSummary(projectId, d.id))
  for (const c of tree.chats) push(`chat:${c.id}`, 'chat', c.title, await readChatSummary(projectId, c.id))
  for (const r of tree.resources) push(`res:${r.id}`, 'res', r.name, await readResourceSummary(projectId, r.id))

  return results.slice(0, 20)
}

// ---------------------------------------------------------------------------
// 大摘要（rollup）：写作文档 > ROLLUP_THRESHOLD 时，按创建时间每 ROLLUP_BATCH 个聚合成整体摘要。
// 基于成员文档摘要生成（非全文，省 token）；成员摘要指纹任一变化 → STALE。
// ---------------------------------------------------------------------------

export const ROLLUP_THRESHOLD = 50
export const ROLLUP_BATCH = 10

function rollupPrompt(lang: Lang): string {
  return lang === 'en'
    ? `You are a story continuity editor. Below are summaries of several documents in chronological order. Distill the cross-document memory and output EXACTLY ONE JSON object (no code fences, no prose):
- "overview": the overall arc of this block, one paragraph, at most 300 words
- "stateChanges": key changes in character/world state (array of strings, each at most 80 words) — write WHAT CHANGED
- "causality": cross-document cause-effect and foreshadowing ledger (array of strings, each at most 80 words) — write what was planted / how it advanced / whether it resolved
Leave a field empty ([] or "") when absent — DO NOT invent. All content in English. Output valid JSON only.`
    : `你是故事连续性编辑。下面是按时间顺序排列的若干文档摘要。请提炼这些文档跨块的总体记忆，输出恰好一个 JSON 对象（不要输出 JSON 以外的任何内容，不要用代码块包裹）：
- "overview"：这段剧情的总体走向，一段话，不超过 300 字
- "stateChanges"：人物状态/世界设定的关键变化，字符串数组，每条不超过 80 字——写"什么变了"
- "causality"：跨篇因果链与伏笔账本，字符串数组，每条不超过 80 字——写"埋了什么/如何推进/是否回收"
信息不足的字段留空数组或空字符串，禁止编造。只输出合法 JSON。`
}

function normalizeRollup(parsed: unknown): { overview: string; stateChanges: string[]; causality: string[] } {
  const p = (parsed ?? {}) as Record<string, unknown>
  const arr = (v: unknown): string[] => (Array.isArray(v) ? (v as unknown[]).map(String) : [])
  return { overview: String(p.overview ?? ''), stateChanges: arr(p.stateChanges), causality: arr(p.causality) }
}

async function buildRollupForChunk(
  projectId: string,
  docs: { id: string }[],
  rangeLabel: string,
  settings: ApiSettings,
  existingRollup: DocRollup | undefined,
  force: boolean
): Promise<DocRollup | null> {
  const fingerprints: Record<string, string> = {}
  const summaries: DocSummary[] = []
  for (const d of docs) {
    const s = await readDocSummary(projectId, d.id)
    if (s) {
      summaries.push(s)
      fingerprints[d.id] = s.sourceFingerprint || ''
    }
  }
  if (summaries.length !== docs.length) return null

  // 成员未变且非强制 → 复用
  if (!force && existingRollup && existingRollup.overview) {
    let same = true
    for (const [docId, fp] of Object.entries(fingerprints)) {
      if (existingRollup.sourceFingerprints[docId] !== fp) {
        same = false
        break
      }
    }
    if (same) return existingRollup
  }

  const content = summaries.map((s, i) => `【${i + 1}】\n${storyBlock(s, settings.language)}`).join('\n\n')
  return enqueueLlm(async () => {
    const client = makeClient(settings)
    let parsed: { overview: string; stateChanges: string[]; causality: string[] } | null = null
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await client.chat.completions.create({
        model: settings.model,
        messages: [
          { role: 'system', content: rollupPrompt(settings.language) },
          { role: 'user', content: content }
        ],
        temperature: 0.3,
        max_tokens: 2048
      })
      if (res.usage) await recordUsage(res.usage, 'summary')
      parsed = normalizeRollup(parseJson(res.choices[0]?.message?.content ?? ''))
      if (parsed.overview.trim()) break
    }
    if (!parsed || !parsed.overview.trim()) return null
    return {
      id: `${projectId}:${rangeLabel}`,
      projectId,
      docIds: docs.map((d) => d.id),
      rangeLabel,
      overview: parsed.overview,
      stateChanges: parsed.stateChanges,
      causality: parsed.causality,
      schemaVersion: SUMMARY_SCHEMA_VERSION,
      sourceFingerprints: fingerprints,
      updatedAt: nowIso()
    } as DocRollup
  })
}

/** 生成/刷新项目大摘要（增量：成员未变的块复用） */
export async function generateDocRollups(projectId: string): Promise<{ ok: boolean; error?: string }> {
  const cfg = await loadConfig()
  if (!cfg.summaryEnabled) return { ok: false, error: '摘要功能未开启' }
  const settings = await loadApiSettings()
  if (!settings.apiKey) return { ok: false, error: '未配置 API Key' }
  const tree = (await buildSnapshot()).projects.find((p) => p.project.id === projectId)
  if (!tree) return { ok: false, error: '项目不存在' }

  const docs = [...tree.docs].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  if (docs.length < ROLLUP_THRESHOLD) {
    await writeDocRollups(projectId, [])
    return { ok: true }
  }

  const existing = await readDocRollups(projectId)
  const rollups: DocRollup[] = []
  try {
    for (let i = 0; i < docs.length; i += ROLLUP_BATCH) {
      const group = docs.slice(i, i + ROLLUP_BATCH)
      const rangeLabel = `${i + 1}-${Math.min(i + ROLLUP_BATCH, docs.length)}`
      const existingRollup = existing.find((r) => r.rangeLabel === rangeLabel && r.docIds.length === group.length)
      const rollup = await buildRollupForChunk(projectId, group, rangeLabel, settings, existingRollup, false)
      if (rollup) rollups.push(rollup)
    }
    await writeDocRollups(projectId, rollups)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** 单条重新生成大摘要 */
export async function regenerateDocRollup(projectId: string, rollupId: string): Promise<{ ok: boolean; error?: string }> {
  const settings = await loadApiSettings()
  if (!settings.apiKey) return { ok: false, error: '未配置 API Key' }
  const existing = await readDocRollups(projectId)
  const target = existing.find((r) => r.id === rollupId)
  if (!target) return { ok: false, error: '大摘要不存在' }
  const tree = (await buildSnapshot()).projects.find((p) => p.project.id === projectId)
  const docs = (tree?.docs ?? []).filter((d) => target.docIds.includes(d.id))
  const rollup = await buildRollupForChunk(projectId, docs, target.rangeLabel, settings, target, true)
  if (!rollup) return { ok: false, error: '生成失败：成员文档摘要不完整' }
  const next = existing.map((r) => (r.id === rollupId ? rollup : r))
  await writeDocRollups(projectId, next)
  return { ok: true }
}

/** 读取单条大摘要（预览） */
export async function getDocRollup(projectId: string, rollupId: string): Promise<DocRollup | null> {
  const rollups = await readDocRollups(projectId)
  return rollups.find((r) => r.id === rollupId) ?? null
}

/** 大摘要概览（设置页），含 STALE 检测 */
export async function listDocRollups(projectId: string): Promise<DocRollupOverview> {
  const tree = (await buildSnapshot()).projects.find((p) => p.project.id === projectId)
  const totalDocs = tree?.docs.length ?? 0
  const rollups = await readDocRollups(projectId)
  const items = await Promise.all(
    rollups.map(async (r) => {
      let stale = false
      for (const docId of r.docIds) {
        const s = await readDocSummary(projectId, docId)
        if (!s) {
          stale = true
          break
        }
        if ((s.sourceFingerprint || '') !== (r.sourceFingerprints[docId] ?? '')) {
          stale = true
          break
        }
      }
      return { id: r.id, rangeLabel: r.rangeLabel, docCount: r.docIds.length, updatedAt: r.updatedAt, stale, generating: false }
    })
  )
  return { rollups: items, totalDocs, threshold: ROLLUP_THRESHOLD, batchSize: ROLLUP_BATCH }
}

// ---------------------------------------------------------------------------
// 摘要 → prompt 格式化
// ---------------------------------------------------------------------------

function storyBlock(s: StorySummary, lang: Lang): string {
  const en = lang === 'en'
  const none = en ? '(none)' : '（无）'
  const chars = (Array.isArray(s.characters) ? s.characters : [])
    .map((c) =>
      en
        ? `- ${c.name}${c.aliases.length ? ` (${c.aliases.join(', ')})` : ''}: ${c.role}${c.goal ? ` · Goal: ${c.goal}` : ''}`
        : `- ${c.name}${c.aliases.length ? `（${c.aliases.join('、')}）` : ''}：${c.role}${c.goal ? ` · 目标：${c.goal}` : ''}`
    )
    .join('\n')
  const plot = (Array.isArray(s.plot) ? s.plot : []).map((p) => `- ${p.id}｜${p.function}：${p.summary}`).join('\n')
  const fs = (Array.isArray(s.foreshadowing) ? s.foreshadowing : [])
    .map((f) => (en ? `- ${f.planted} (${f.status === 'resolved' ? 'resolved' : 'unresolved'})` : `- ${f.planted}（${f.status === 'resolved' ? '已回收' : '未回收'}）`))
    .join('\n')
  const settings = Array.isArray(s.keySettings) ? s.keySettings : []
  const quotes = Array.isArray(s.keyQuotes) ? s.keyQuotes : []
  if (en) {
    return `Overview: ${s.overview || none}\n\nCharacters:\n${chars || none}\n\nPlot:\n${plot || none}\n\nForeshadowing:\n${fs || none}\n\nKey settings: ${settings.join(', ') || none}\nKey quotes: ${quotes.join(' / ') || none}`
  }
  return `总览：${s.overview || none}\n\n人物：\n${chars || none}\n\n情节链：\n${plot || none}\n\n伏笔：\n${fs || none}\n\n关键设定：${settings.join('、') || none}\n关键台词：${quotes.join(' / ') || none}`
}

export function buildDocSummaryBlock(s: DocSummary, lang: Lang = 'zh'): string {
  return lang === 'en' ? `【Document summary】\n${storyBlock(s, lang)}` : `【文档摘要】\n${storyBlock(s, lang)}`
}

export function buildChatSummaryBlock(s: ChatSummary, lang: Lang = 'zh'): string {
  const en = lang === 'en'
  const lines = (Array.isArray(s.items) ? s.items : [])
    .map((i) => `${i.role === 'user' ? (en ? 'User' : '用户') : 'AI'}：${i.summary}`)
    .join('\n')
  return en ? `【Chat summary】\n${lines || '(none)'}` : `【对话摘要】\n${lines || '（无）'}`
}

export function buildResourceSummaryBlock(s: ResourceSummary, name: string, lang: Lang = 'zh'): string {
  const en = lang === 'en'
  if (s.type === 'story') {
    return en ? `【Resource summary: ${name}】\n${storyBlock(s, lang)}` : `【资源摘要：${name}】\n${storyBlock(s, lang)}`
  }
  const keyPoints = Array.isArray(s.keyPoints) ? s.keyPoints : []
  const keyTerms = Array.isArray(s.keyTerms) ? s.keyTerms : []
  const none = en ? '(none)' : '（无）'
  if (en) {
    return `【Resource summary: ${name}】\nType: ${s.docType || 'unknown'}\nOverview: ${s.overview || none}\nKey points:\n${keyPoints.map((p) => `- ${p}`).join('\n') || none}\nTerms: ${keyTerms.join(', ') || none}\nStructure: ${s.structure || none}`
  }
  return `【资源摘要：${name}】\n类型：${s.docType || '未知'}\n概述：${s.overview || none}\n要点：\n${keyPoints.map((p) => `- ${p}`).join('\n') || none}\n术语：${keyTerms.join('、') || none}\n结构：${s.structure || none}`
}
