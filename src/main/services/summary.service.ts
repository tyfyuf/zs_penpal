import type {
  ChatSummary,
  ChatSummaryInterval,
  ChatSummaryItem,
  ConsistencyIssue,
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
import { logError } from './log.service'
import { executeStructuredTask } from './structured-generation.service'
import { EVENTS } from '@shared/ipc'
import { broadcast } from '../window'
import { analyzeTextIntegrity, assertTextIntegrity } from './text-decoding.service'

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

function storyPrompt(lang: Lang, bounded = false): string {
  const cap = bounded
    ? (lang === 'en'
      ? `\nThis is a long text. To fit the output, LIMIT sizes strictly: at most 20 characters, at most 40 plot points, at most 30 foreshadowing items, at most 40 key settings, at most 40 key quotes. Keep only the MOST important ones; omit the rest.`
      : `\n本文较长。为控制输出，请严格限制规模：人物最多 20 个、情节点最多 40 个、伏笔最多 30 条、关键设定最多 40 条、关键台词最多 40 条。只保留最重要的，其余省略。`)
    : ''
  return lang === 'en'
    ? `You are a story decomposition assistant. Read the full story below and output EXACTLY ONE JSON object (nothing else — no code fences, no prose), with these fields:
- "overview": the main plot in one paragraph, at most 200 words, as complete as possible
- "characters": array of characters, each with "name", "aliases" (array; empty if none), "role", "goal" (empty string if none)
- "plot": array of plot points in story order, each with "id" (e.g. "s1"), "function" (exactly one of: advance/reveal/turn/foreshadow/resolve), "summary" (what happens, at most 80 words, be specific)
- "foreshadowing": array, each with "planted" (what was set up) and "status" (exactly "resolved" or "unresolved")
- "keySettings": array of key settings, each at most 40 words
- "keyQuotes": array of key quotes
Cover the entire text and do not omit important plot points. Leave a field empty ([] or "") when the information is absent — DO NOT invent. All content in English. Output valid JSON only.${cap}`
    : `你是故事拆解助手。请阅读下面的故事全文，输出恰好一个 JSON 对象（不要输出 JSON 以外的任何内容，不要用代码块包裹），字段如下：
- "overview"：主线剧情总览，一段话，不超过 200 字，尽量完整
- "characters"：人物数组，每项含 "name"（名字）、"aliases"（别名数组，无则空数组）、"role"（身份）、"goal"（目标，无则空字符串）
- "plot"：按故事顺序的情节点数组，每项含 "id"（如 s1）、"function"（只能取：推进/揭示/转折/铺垫/收束）、"summary"（这个情节点发生了什么，每点不超过 80 字，尽量具体）
- "foreshadowing"：伏笔数组，每项含 "planted"（埋了什么）、"status"（只能取 resolved 或 unresolved）
- "keySettings"：关键设定，字符串数组，每条不超过 40 字
- "keyQuotes"：关键台词，字符串数组
要求覆盖全文、不遗漏重要情节；信息不足的字段留空数组或空字符串，禁止编造。只输出合法 JSON。${cap}`
}

function genericPrompt(lang: Lang, bounded = false): string {
  const cap = bounded
    ? (lang === 'en'
      ? `\nThis is a long text. To fit the output, LIMIT sizes strictly: at most 40 keyPoints and at most 40 keyTerms. Keep only the MOST important ones.`
      : `\n本文较长。为控制输出，请严格限制规模：keyPoints 最多 40 条、keyTerms 最多 40 条。只保留最重要的。`)
    : ''
  return lang === 'en'
    ? `You are a text decomposition assistant. Read the full text below and output EXACTLY ONE JSON object (nothing else — no code fences, no prose), with these fields:
- "docType": the content type (one of: code/transcript/legal/table/narrative/email/encyclopedia/data/reference)
- "overview": a summary of the content, one paragraph, at most 200 words
- "keyPoints": key points, array of strings ordered by importance, each at most 80 words
- "keyTerms": key terms/entities, array of strings, each at most 40 words
- "structure": an overview of the structure/sections, at most 200 words
Leave a field empty ([] or "") when absent — DO NOT invent. All content in English. Output valid JSON only.${cap}`
    : `你是文本拆解助手。请阅读下面的文本全文，输出恰好一个 JSON 对象（不要输出 JSON 以外的任何内容，不要用代码块包裹），字段如下：
- "docType"：内容类型（只能取：代码/对话记录/法律条款/表格/叙事/邮件/百科/数据/参考）
- "overview"：内容概述，一段话，不超过 200 字
- "keyPoints"：核心要点，字符串数组，按重要性排列，每条不超过 80 字
- "keyTerms"：关键术语/实体，字符串数组，每条不超过 40 字
- "structure"：结构/章节概览，不超过 200 字
信息不足的字段留空数组或空字符串，禁止编造。只输出合法 JSON。${cap}`
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

/** 对话摘要增量压缩参数 */
const CHAT_TAIL_WINDOW = 20
const CHAT_COMPACT_THRESHOLD = 40
const CHAT_COMPACT_BATCH = 10

function chatIntervalPrompt(lang: Lang): string {
  return lang === 'en'
    ? `Summarize this segment of a writing discussion into a JSON object with one field:
{ "summary": "..." }
Write a concise paragraph (at most 200 words) covering: what progressed, key decisions, and outstanding todos. Output only the JSON.`
    : `请为下面这段写作讨论记录生成区间摘要，输出恰好一个 JSON 对象：
{ "summary": "..." }
summary 用简洁段落概括这段讨论的进展、关键决策、待办事项（不超过 200 字）。只输出 JSON，不要输出其他内容。`
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

const STORY_FUNCTIONS = new Set([
  'advance', 'reveal', 'turn', 'foreshadow', 'resolve',
  '\u63a8\u8fdb', '\u63ed\u793a', '\u8f6c\u6298', '\u94fa\u57ab', '\u6536\u675f'
])
const GENERIC_DOC_TYPES = new Set(['code', 'transcript', 'legal', 'table', 'narrative', 'email', 'encyclopedia', 'data', 'reference'])

function cleanText(value: unknown, max = 1200): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function cleanStrings(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => cleanText(item, maxLength)).filter(Boolean).slice(0, maxItems)
}

function normalizeStory(parsed: unknown, compact = false): StorySummary {
  const p = (parsed ?? {}) as Record<string, unknown>
  const chars = Array.isArray(p.characters) ? (p.characters as Record<string, unknown>[]) : []
  const plot = Array.isArray(p.plot) ? (p.plot as Record<string, unknown>[]) : []
  const fs = Array.isArray(p.foreshadowing) ? (p.foreshadowing as Record<string, unknown>[]) : []
  const charLimit = compact ? 8 : 12
  const plotLimit = compact ? 16 : 24
  const otherLimit = compact ? 8 : 12
  return {
    type: 'story',
    overview: cleanText(p.overview, 800),
    characters: chars.map((c) => ({
      name: cleanText(c.name, 120), aliases: cleanStrings(c.aliases, 12, 120),
      role: cleanText(c.role, 240), goal: cleanText(c.goal, 320)
    })).filter((c) => c.name).slice(0, charLimit),
    plot: plot.map((pl, i) => ({
      id: cleanText(pl.id, 80) || `s${i + 1}`,
      function: cleanText(pl.function, 40), summary: cleanText(pl.summary, 480)
    })).filter((pl) => pl.summary && STORY_FUNCTIONS.has(pl.function)).slice(0, plotLimit),
    foreshadowing: fs.map((f) => ({
      planted: cleanText(f.planted, 360),
      status: f.status === 'resolved' ? ('resolved' as const) : ('unresolved' as const)
    })).filter((f) => f.planted).slice(0, otherLimit),
    keySettings: cleanStrings(p.keySettings, otherLimit, 240),
    keyQuotes: cleanStrings(p.keyQuotes, compact ? 5 : 8, 320)
  }
}

function validStory(parsed: unknown, compact = false): StorySummary | null {
  const summary = normalizeStory(parsed, compact)
  return summary.overview ? summary : null
}

function normalizeGeneric(parsed: unknown, compact = false): GenericResourceSummary {
  const p = (parsed ?? {}) as Record<string, unknown>
  const docType = cleanText(p.docType, 80)
  return {
    type: 'other', docType: GENERIC_DOC_TYPES.has(docType) ? docType : 'reference',
    overview: cleanText(p.overview, 800),
    keyPoints: cleanStrings(p.keyPoints, compact ? 12 : 24, 480),
    keyTerms: cleanStrings(p.keyTerms, compact ? 12 : 20, 240),
    structure: cleanText(p.structure, 800)
  }
}

function validGeneric(parsed: unknown, compact = false): GenericResourceSummary | null {
  const summary = normalizeGeneric(parsed, compact)
  return summary.overview && summary.keyPoints.length > 0 ? summary : null
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

async function callStoryDecomposition(content: string, cfg: ApiSettings): Promise<StorySummary> {
  const tokens = estimateInputTokens(content, cfg.model)
  const budget = inputBudget(cfg)
  if (tokens > budget) {
    throw new Error('Document exceeds the configured input-context budget (60%).')
  }
  const userContent = content || '(empty document)'
  return enqueueLlm(() => executeStructuredTask({
    task: 'story_decomposition', settings: cfg,
    messages: [
      { role: 'system', content: storyPrompt(cfg.language, true) },
      { role: 'user', content: userContent }
    ],
    compactMessages: [
      { role: 'system', content: `${storyPrompt(cfg.language, true)}\nUse half as many items as the stated limits. Prefer a closed valid result over exhaustive coverage.` },
      { role: 'user', content: userContent }
    ],
    outputTokens: 4096, compactOutputTokens: 2048,
    parseAndValidate: (raw) => validStory(parseJson(raw), false)
  }))
}

async function callGenericDecomposition(content: string, cfg: ApiSettings): Promise<GenericResourceSummary> {
  const tokens = estimateInputTokens(content, cfg.model)
  const budget = inputBudget(cfg)
  if (tokens > budget) {
    throw new Error('Document exceeds the configured input-context budget (60%).')
  }
  const userContent = content || '(empty content)'
  return enqueueLlm(() => executeStructuredTask({
    task: 'generic_decomposition', settings: cfg,
    messages: [
      { role: 'system', content: genericPrompt(cfg.language, true) },
      { role: 'user', content: userContent }
    ],
    compactMessages: [
      { role: 'system', content: `${genericPrompt(cfg.language, true)}\nUse half as many items as the stated limits. Prefer a closed valid result over exhaustive coverage.` },
      { role: 'user', content: userContent }
    ],
    outputTokens: 3072, compactOutputTokens: 1536,
    parseAndValidate: (raw) => validGeneric(parseJson(raw), false)
  }))
}

/** Three-section sampling: beginning / middle / end avoids a head-only classification. */
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
  return enqueueLlm(() => executeStructuredTask({
    task: 'resource_classification', settings: cfg,
    messages: [
      { role: 'system', content: classifyPrompt(cfg.language) },
      { role: 'user', content: sampleSections(content) }
    ],
    outputTokens: 256, compactOutputTokens: 192,
    parseAndValidate: (raw) => {
      const parsed = parseJson<{ type?: unknown; confidence?: unknown; reasons?: unknown }>(raw)
      if (!parsed) return null
      const typeText = String(parsed.type ?? '').toLowerCase()
      const type = typeText === 'story' ? 'story' : typeText === 'other' ? 'other' : null
      const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : Number(parsed.confidence)
      if (!type || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null
      return { type, confidence, reasons: cleanStrings(parsed.reasons, 4, 240) }
    }
  }))
}

// ---------------------------------------------------------------------------
// Document summaries
// ---------------------------------------------------------------------------

/** Estimate changed characters; retained for compatibility with historical callers. */
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
  assertTextIntegrity(analyzeTextIntegrity(content), '\u6587\u6863')
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
    } catch (err) {
      logError('summary:doc', `文档摘要生成失败 docId=${docId}`, (err as Error).message)
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
  } catch (err) {
    logError('summary:doc', `文档摘要更新失败 docId=${docId}`, (err as Error).message)
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
    // 尾部窗口：最近 CHAT_TAIL_WINDOW 条逐条摘要（增量：只重算尾部，不重算全量）
    const tailStart = Math.max(0, turns.length - CHAT_TAIL_WINDOW)
    const items = await summarizeTurnItems(turns.slice(tailStart), cfg)

    // 历史压缩区间：消息数超阈值 或 对话 token 估算超输入预算 60% 时，把尾部窗口之前的旧消息按 CHAT_COMPACT_BATCH 聚合（增量追加）
    const dialogueTokens = estimateInputTokens(
      turns.map((m) => m.content).join('\n'),
      cfg.model
    )
    const needCompact = turns.length > CHAT_COMPACT_THRESHOLD || dialogueTokens > inputBudget(cfg) * 0.6
    let compacted: ChatSummaryInterval[] = []
    if (needCompact) {
      const prev = force ? [] : Array.isArray(existing?.compacted) ? existing.compacted : []
      const kept = prev.filter((iv) => iv.endIndex < tailStart)
      compacted = [...kept]
      const lastCovered = kept.reduce((m, iv) => Math.max(m, iv.endIndex), -1)
      const preTailEnd = tailStart - 1
      for (let s = lastCovered + 1; s <= preTailEnd; s += CHAT_COMPACT_BATCH) {
        const e = Math.min(s + CHAT_COMPACT_BATCH - 1, preTailEnd)
        const summary = await summarizeInterval(turns.slice(s, e + 1), cfg)
        if (summary) compacted.push({ startIndex: s, endIndex: e, summary, updatedAt: nowIso() })
      }
    }

    await writeChatSummary(chat.projectId, chatId, {
      schemaVersion: SUMMARY_SCHEMA_VERSION,
      items,
      compacted,
      updatedAt: nowIso(),
      lastMessageId,
      messageCount
    })
  } finally {
    markDone(key)
  }
}

/** 逐条摘要（尾部窗口），与消息一一对齐 */
function formatChatTurns(turns: { id?: string; role: string; content: string }[], maxPerMessage = 1800): string {
  return turns.map((m, index) => {
    const source = m.content ?? ''
    const content = source.length > maxPerMessage
      ? `${source.slice(0, maxPerMessage)}\n[This message was shortened only for the summary request; its id is still required.]`
      : source
    const id = m.id ?? `interval-${index + 1}`
    const role = m.role === 'user' ? 'user' : 'assistant'
    return `messageId: ${JSON.stringify(id)}\nrole: ${role}\ncontent:\n${content}`
  }).join('\n\n---\n\n')
}

/** Strictly validate identity and role: never map model output back by position alone. */
async function summarizeTurnItems(
  turns: { id: string; role: string; content: string }[], cfg: ApiSettings
): Promise<ChatSummaryItem[]> {
  if (turns.length === 0) return []
  return enqueueLlm(() => executeStructuredTask({
    task: 'chat_turn_summary', settings: cfg,
    messages: [
      { role: 'system', content: `${chatPrompt(cfg.language)}\nEach object must include messageId.` },
      { role: 'user', content: formatChatTurns(turns) }
    ],
    compactMessages: [
      { role: 'system', content: `${chatPrompt(cfg.language)}\nEach object must include messageId. Prefer a short valid result.` },
      { role: 'user', content: formatChatTurns(turns, 800) }
    ],
    outputTokens: 2048, compactOutputTokens: 1280,
    parseAndValidate: (raw) => {
      const parsed = parseJson<{ messageId?: unknown; role?: unknown; summary?: unknown }[]>(raw)
      if (!Array.isArray(parsed) || parsed.length !== turns.length) return null
      const byId = new Map<string, { messageId?: unknown; role?: unknown; summary?: unknown }>()
      for (const item of parsed) {
        const id = cleanText(item.messageId, 200)
        if (!id || byId.has(id)) return null
        byId.set(id, item)
      }
      const result: ChatSummaryItem[] = []
      for (const turn of turns) {
        const item = byId.get(turn.id)
        const role = turn.role === 'user' ? 'user' : 'assistant'
        const summary = cleanText(item?.summary, 300)
        if (!item || item.role !== role || !summary) return null
        result.push({ messageId: turn.id, role, summary })
      }
      return result
    }
  }))
}

async function summarizeInterval(turns: { role: string; content: string }[], cfg: ApiSettings): Promise<string> {
  return enqueueLlm(() => executeStructuredTask({
    task: 'chat_interval_summary', settings: cfg,
    messages: [
      { role: 'system', content: chatIntervalPrompt(cfg.language) },
      { role: 'user', content: formatChatTurns(turns) }
    ],
    compactMessages: [
      { role: 'system', content: `${chatIntervalPrompt(cfg.language)}\nPrefer a short valid result.` },
      { role: 'user', content: formatChatTurns(turns, 800) }
    ],
    outputTokens: 1024, compactOutputTokens: 512,
    parseAndValidate: (raw) => cleanText(parseJson<{ summary?: unknown }>(raw)?.summary, 1000) || null
  }))
}

async function runQueuedChatSummary(chatId: string, force: boolean, propagate: boolean): Promise<void> {
  try {
    await generateChatSummary(chatId, force)
    pendingRetry.delete(chatId)
    await persistRetry()
  } catch (err) {
    pendingRetry.add(chatId)
    await persistRetry()
    logError('summary:chat', `Chat summary generation failed chatId=${chatId}`, (err as Error).message)
    if (propagate) throw err
  }
}

export function queueChatSummary(chatId: string, force = false): Promise<void> {
  return enqueue(() => runQueuedChatSummary(chatId, force, false))
}

/** Manual calls propagate failure; this fixes the historical false-success response. */
export async function regenerateChatSummary(chatId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const cfg = await loadConfig()
    if (!cfg.summaryEnabled) return { ok: false, error: 'Summary feature is disabled' }
    await enqueue(() => runQueuedChatSummary(chatId, true, true))
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
    const resource = await readResource(projectId, resourceId)
    assertTextIntegrity(resource.encoding, resource.name)
    content = resource.content
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
    const { content, encoding } = await readResource(projectId, resourceId)
    if (encoding.suspicious) return true
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

/** 别名冲突检测：两个角色名字互为别名，或别名集合有交集（R1） */
function findAliasConflicts(s: { characters: { name: string; aliases: string[] }[] }): { a: string; b: string; alias: string }[] {
  const chars = Array.isArray(s.characters) ? s.characters : []
  const conflicts: { a: string; b: string; alias: string }[] = []
  for (let i = 0; i < chars.length; i++) {
    for (let j = i + 1; j < chars.length; j++) {
      const A = chars[i]
      const B = chars[j]
      const aName = (A.name ?? '').trim().toLowerCase()
      const bName = (B.name ?? '').trim().toLowerCase()
      const aAliases = new Set((A.aliases ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean))
      const bAliases = new Set((B.aliases ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean))
      if (aName && bAliases.has(aName)) {
        conflicts.push({ a: A.name, b: B.name, alias: aName })
      } else if (bName && aAliases.has(bName)) {
        conflicts.push({ a: A.name, b: B.name, alias: bName })
      } else {
        for (const al of aAliases) {
          if (bAliases.has(al)) {
            conflicts.push({ a: A.name, b: B.name, alias: al })
            break
          }
        }
      }
    }
  }
  return conflicts
}

/** 一致性扫描（纯规则）：R1 别名冲突（error）+ R4 摘要漂移（advisory） */
export async function scanConsistency(projectId: string): Promise<ConsistencyIssue[]> {
  const issues: ConsistencyIssue[] = []
  const tree = (await buildSnapshot()).projects.find((p) => p.project.id === projectId)
  if (!tree) return issues

  // R1：文档摘要的别名冲突
  for (const d of tree.docs) {
    const s = await readDocSummary(projectId, d.id)
    if (!s) continue
    for (const c of findAliasConflicts(s)) {
      issues.push({
        kind: 'alias_conflict',
        severity: 'error',
        message: `「${c.a}」与「${c.b}」别名重叠（${c.alias}），疑似同一角色`,
        docId: d.id
      })
    }
  }
  // R1：故事型资源摘要的别名冲突
  for (const r of tree.resources) {
    try {
      if ((await readResource(projectId, r.id)).encoding.suspicious) continue
    } catch {
      continue
    }
    const s = await readResourceSummary(projectId, r.id)
    if (s && s.type === 'story') {
      for (const c of findAliasConflicts(s)) {
        issues.push({
          kind: 'alias_conflict',
          severity: 'error',
          message: `「${r.name}」中「${c.a}」与「${c.b}」别名重叠（${c.alias}）`,
          resourceId: r.id
        })
      }
    }
  }
  // R4：资源摘要漂移（待更新）
  for (const r of tree.resources) {
    if (await checkResourceSummaryStale(projectId, r.id)) {
      issues.push({ kind: 'stale_summary', severity: 'advisory', message: `资源「${r.name}」摘要待更新`, resourceId: r.id })
    }
  }
  return issues
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
      try {
        if ((await readResource(projectId, r.id)).encoding.suspicious) return null
      } catch {
        return null
      }
      const summary = await readResourceSummary(projectId, r.id)
      const generating = isSummaryGenerating(`res:${r.id}`)
      const stale = summary ? await checkResourceSummaryStale(projectId, r.id) : false
      return { resourceId: r.id, name: r.name, distilled: !!summary, type: summary?.type, updatedAt: summary?.updatedAt, generating, stale }
    })
  )
  return { docs, chats, resources: resources.filter((resource): resource is NonNullable<typeof resource> => !!resource && (resource.distilled || resource.generating)) }
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
    const items = s.items.map((i) => i.summary).join(' ')
    const compacted = Array.isArray(s.compacted) ? (s.compacted as ChatSummaryInterval[]).map((iv) => iv.summary).join(' ') : ''
    return `${items} ${compacted}`
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
  for (const r of tree.resources) {
    try {
      if ((await readResource(projectId, r.id)).encoding.suspicious) continue
      push(`res:${r.id}`, 'res', r.name, await readResourceSummary(projectId, r.id))
    } catch {
      // Deleted or unreadable resources are excluded from summary search.
    }
  }

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

function validRollup(parsed: unknown, compact = false): { overview: string; stateChanges: string[]; causality: string[] } | null {
  const p = (parsed ?? {}) as Record<string, unknown>
  const result = {
    overview: cleanText(p.overview, 1200),
    stateChanges: cleanStrings(p.stateChanges, compact ? 8 : 16, 480),
    causality: cleanStrings(p.causality, compact ? 8 : 16, 480)
  }
  return result.overview ? result : null
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
    const summary = await readDocSummary(projectId, d.id)
    if (summary) {
      summaries.push(summary)
      fingerprints[d.id] = summary.sourceFingerprint || ''
    }
  }
  if (summaries.length !== docs.length) return null

  if (!force && existingRollup && existingRollup.overview) {
    const unchanged = Object.entries(fingerprints).every(([docId, fingerprint]) => existingRollup.sourceFingerprints[docId] === fingerprint)
    if (unchanged) return existingRollup
  }

  const content = summaries.map((summary, index) => `[#${index + 1}]\n${storyBlock(summary, settings.language)}`).join('\n\n')
  try {
    const parsed = await enqueueLlm(() => executeStructuredTask({
      task: 'document_rollup', settings,
      messages: [
        { role: 'system', content: rollupPrompt(settings.language) },
        { role: 'user', content }
      ],
      compactMessages: [
        { role: 'system', content: `${rollupPrompt(settings.language)}\nUse at most 8 stateChanges and 8 causality items. Prefer a short valid result.` },
        { role: 'user', content }
      ],
      outputTokens: 2048, compactOutputTokens: 1024,
      parseAndValidate: (raw) => validRollup(parseJson(raw), false)
    }))
    return {
      id: `${projectId}:${rangeLabel}`, projectId, docIds: docs.map((d) => d.id), rangeLabel,
      overview: parsed.overview, stateChanges: parsed.stateChanges, causality: parsed.causality,
      schemaVersion: SUMMARY_SCHEMA_VERSION, sourceFingerprints: fingerprints, updatedAt: nowIso()
    } as DocRollup
  } catch (err) {
    logError('summary:rollup', `Rollup generation failed projectId=${projectId} range=${rangeLabel}`, (err as Error).message)
    return null
  }
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
      if (!rollup) return { ok: false, error: `Rollup generation incomplete for group ${rangeLabel}` }
      rollups.push(rollup)
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
  const head = en ? '【Chat summary】' : '【对话摘要】'
  const none = en ? '(none)' : '（无）'
  const parts: string[] = []
  const compacted = Array.isArray(s.compacted) ? s.compacted : []
  if (compacted.length > 0) {
    const hist = compacted.map((iv) => `- ${iv.summary}`).join('\n')
    parts.push(en ? `Earlier (compressed):\n${hist}` : `历史（已压缩）：\n${hist}`)
  }
  const lines = (Array.isArray(s.items) ? s.items : [])
    .map((i) => `${i.role === 'user' ? (en ? 'User' : '用户') : 'AI'}：${i.summary}`)
    .join('\n')
  if (lines) parts.push(en ? `Recent:\n${lines}` : `最近：\n${lines}`)
  return `${head}\n${parts.join('\n\n') || none}`
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

/** 大摘要（rollup）注入块 */
export function buildRollupBlock(r: DocRollup, lang: Lang = 'zh'): string {
  const en = lang === 'en'
  const none = en ? '(none)' : '（无）'
  const changes = (Array.isArray(r.stateChanges) ? r.stateChanges : []).map((s) => `- ${s}`).join('\n')
  const causal = (Array.isArray(r.causality) ? r.causality : []).map((s) => `- ${s}`).join('\n')
  if (en) {
    return `【Rollup: docs ${r.rangeLabel}】\nOverview: ${r.overview || none}\nState changes:\n${changes || none}\nCausality/foreshadowing:\n${causal || none}`
  }
  return `【大摘要：第 ${r.rangeLabel} 篇】\n总览：${r.overview || none}\n状态变化：\n${changes || none}\n因果/伏笔：\n${causal || none}`
}

/** 大摘要目录（供 B 两段式记忆菜单第一遍决策用） */
export function buildRollupCatalogBlock(rollups: DocRollup[], lang: Lang = 'zh'): string {
  const en = lang === 'en'
  const lines = rollups.map((r) => `- id="${r.id}" ${r.rangeLabel}: ${r.overview.slice(0, 60)}`).join('\n')
  return en
    ? `Available document rollups (larger memory). If the injected summaries are not enough for the user's question, you may request to expand up to 5 of these. Respond with JSON only:\n${lines}`
    : `可用的大摘要（更粗粒度的记忆）。如果已注入的小摘要不足以回答用户问题，你可以请求展开其中最多 5 个。只输出 JSON：\n${lines}`
}
