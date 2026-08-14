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

// ---------------------------------------------------------------------------
// 摘要系统（重写）：
// - 写作文档摘要：故事拆解（结构化故事摘要，见 story-decomposition-guide 简化版）
// - 对话摘要：按顺序逐条生成简短摘要（关闭窗口时批量 + 变化检测）
// - 资源摘要：蒸馏（先分类校验，再按 故事/其他 生成），可取消
// - 全部复用主模型，独立低温度参数，用量打标 source: 'summary'
// ---------------------------------------------------------------------------

const STORY_PROMPT = `你是小说/剧本的结构化拆解助手。请阅读下面的故事正文，输出一个 JSON 对象（不要输出其他任何内容），字段如下：
{
  "overview": "一段话总览（覆盖主线剧情）",
  "characters": [ { "name": "人物 canonical 名", "aliases": ["别名"], "role": "身份", "goal": "当前目标" } ],
  "plot": [ { "id": "s1", "function": "推进/揭示/转折/铺垫/收束", "summary": "这一情节发生了什么" } ],
  "foreshadowing": [ { "planted": "埋下的伏笔", "status": "resolved 或 unresolved" } ],
  "keySettings": ["关键设定"],
  "keyQuotes": ["关键台词"]
}
只依据原文提炼，不要编造，不要省略。输出必须是合法 JSON。`

const GENERIC_PROMPT = `你是通用文本文件的拆解助手。请阅读下面的文本内容，输出一个 JSON 对象（不要输出其他任何内容），字段如下：
{
  "docType": "内容类型（代码/对话记录/法律条款/表格/叙事/邮件/百科等）",
  "overview": "一句话概述",
  "keyPoints": ["核心要点"],
  "keyTerms": ["关键术语/实体"],
  "structure": "结构/章节概览"
}
只依据原文，不要编造。输出必须是合法 JSON。`

const CLASSIFY_PROMPT = `请判断下面文本的内容类型，只输出一个词：
- 如果它是小说、剧本、故事类叙事作品（有人物、情节、叙事），输出 "story"
- 否则输出 "other"
只输出 story 或 other。`

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
  return new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey! })
}

async function callStoryDecomposition(content: string, cfg: ApiSettings): Promise<StorySummary> {
  const client = makeClient(cfg)
  const res = await client.chat.completions.create({
    model: cfg.model,
    messages: [
      { role: 'system', content: STORY_PROMPT },
      { role: 'user', content: content.slice(0, 30000) || '（空文档）' }
    ],
    temperature: 0.3,
    max_tokens: 4096
  })
  if (res.usage) await recordUsage(res.usage, 'summary')
  return normalizeStory(parseJson(res.choices[0]?.message?.content ?? ''))
}

async function callGenericDecomposition(content: string, cfg: ApiSettings): Promise<GenericResourceSummary> {
  const client = makeClient(cfg)
  const res = await client.chat.completions.create({
    model: cfg.model,
    messages: [
      { role: 'system', content: GENERIC_PROMPT },
      { role: 'user', content: content.slice(0, 30000) || '（空内容）' }
    ],
    temperature: 0.3,
    max_tokens: 2048
  })
  if (res.usage) await recordUsage(res.usage, 'summary')
  return normalizeGeneric(parseJson(res.choices[0]?.message?.content ?? ''))
}

async function classifyContentType(content: string, cfg: ApiSettings): Promise<'story' | 'other'> {
  const client = makeClient(cfg)
  const res = await client.chat.completions.create({
    model: cfg.model,
    messages: [
      { role: 'system', content: CLASSIFY_PROMPT },
      { role: 'user', content: content.slice(0, 8000) }
    ],
    temperature: 0,
    max_tokens: 16
  })
  if (res.usage) await recordUsage(res.usage, 'summary')
  const raw = (res.choices[0]?.message?.content ?? '').trim().toLowerCase()
  return raw.includes('story') ? 'story' : 'other'
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
    try {
      const summary = await generateDocSummary(projectId, docId, currentContent, settings)
      await writeDocSummary(projectId, docId, summary)
      return summary
    } catch {
      return null
    }
  }

  const changed = estimateChangedChars(existing.snapshot ?? '', currentContent)
  const netAdded = Math.max(0, currentContent.length - (existing.snapshot?.length ?? 0))
  const needUpdate = changed / Math.max(existing.snapshotLength, 1) > 0.3 || netAdded > 500
  if (!needUpdate) return existing

  try {
    const summary = await generateDocSummary(projectId, docId, currentContent, settings)
    await writeDocSummary(projectId, docId, summary)
    return summary
  } catch {
    return existing
  }
}

/** 手动重新生成文档摘要（摘要区入口） */
export async function regenerateDocSummary(docId: string): Promise<{ ok: boolean; error?: string }> {
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

async function generateChatSummary(chatId: string): Promise<void> {
  const cfg = await loadApiSettings()
  if (!cfg.apiKey) throw new Error('未配置 API Key')

  const { chat, messages } = await getChat(chatId)
  const turns = messages.filter((m) => m.role === 'user' || m.role === 'assistant')
  if (turns.length === 0) return

  const lastMessageId = turns[turns.length - 1].id
  const messageCount = turns.length
  const existing = await readChatSummary(chat.projectId, chatId)
  // 变化检测：无变化则不调用
  if (existing && existing.lastMessageId === lastMessageId && existing.messageCount === messageCount) return

  const client = makeClient(cfg)
  const dialogue = turns
    .map((m) => `${m.role === 'user' ? '用户' : 'AI'}：${m.content}`)
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
  const items: ChatSummaryItem[] = (parsed ?? []).map((it, i) => ({
    messageId: turns[i]?.id ?? `m${i}`,
    role: it.role === 'user' ? ('user' as const) : ('assistant' as const),
    summary: String(it.summary ?? '')
  }))
  await writeChatSummary(chat.projectId, chatId, { items, updatedAt: nowIso(), lastMessageId, messageCount })
}

/** 关闭对话窗口后入队生成对话摘要（PRD 7.5） */
export function queueChatSummary(chatId: string): Promise<void> {
  return enqueue(async () => {
    try {
      await generateChatSummary(chatId)
      pendingRetry.delete(chatId)
      await persistRetry()
    } catch {
      pendingRetry.add(chatId)
      await persistRetry()
    }
  })
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
  type: 'story' | 'other'
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

  // 1. 廉价分类
  let detected: 'story' | 'other'
  try {
    detected = await classifyContentType(content, settings)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }

  // 2. 类型校验
  if (detected !== type) {
    return { ok: false, mismatch: true, detectedType: detected }
  }

  // 3. 生成对应摘要
  try {
    const summary: ResourceSummary =
      type === 'story'
        ? { ...(await callStoryDecomposition(content, settings)), updatedAt: nowIso() }
        : { ...(await callGenericDecomposition(content, settings)), updatedAt: nowIso() }
    await writeResourceSummary(projectId, resourceId, summary)
    return { ok: true, summary, detectedType: detected }
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
      return { docId: d.id, title: d.title, hasSummary: !!s, updatedAt: s?.updatedAt }
    })
  )
  const chats = await Promise.all(
    tree.chats.map(async (c) => {
      const s = await readChatSummary(projectId, c.id)
      return { chatId: c.id, title: c.title, hasSummary: !!s, updatedAt: s?.updatedAt }
    })
  )
  const resources = await Promise.all(
    tree.resources.map(async (r) => {
      const s = await readResourceSummary(projectId, r.id)
      return { resourceId: r.id, name: r.name, distilled: !!s, type: s?.type, updatedAt: s?.updatedAt }
    })
  )
  return { docs, chats, resources }
}

// ---------------------------------------------------------------------------
// 摘要 → prompt 格式化
// ---------------------------------------------------------------------------

function storyBlock(s: StorySummary): string {
  const chars = s.characters
    .map((c) => `- ${c.name}${c.aliases.length ? `（${c.aliases.join('、')}）` : ''}：${c.role}${c.goal ? ` · 目标：${c.goal}` : ''}`)
    .join('\n')
  const plot = s.plot.map((p) => `- ${p.id}｜${p.function}：${p.summary}`).join('\n')
  const fs = s.foreshadowing.map((f) => `- ${f.planted}（${f.status === 'resolved' ? '已回收' : '未回收'}）`).join('\n')
  return `总览：${s.overview || '（无）'}\n\n人物：\n${chars || '（无）'}\n\n情节链：\n${plot || '（无）'}\n\n伏笔：\n${fs || '（无）'}\n\n关键设定：${s.keySettings.join('、') || '（无）'}\n关键台词：${s.keyQuotes.join(' / ') || '（无）'}`
}

export function buildDocSummaryBlock(s: DocSummary): string {
  return `【文档摘要】\n${storyBlock(s)}`
}

export function buildChatSummaryBlock(s: ChatSummary): string {
  const lines = s.items.map((i) => `${i.role === 'user' ? '用户' : 'AI'}：${i.summary}`).join('\n')
  return `【对话摘要】\n${lines || '（无）'}`
}

export function buildResourceSummaryBlock(s: ResourceSummary, name: string): string {
  if (s.type === 'story') {
    return `【资源摘要：${name}】\n${storyBlock(s)}`
  }
  return `【资源摘要：${name}】\n类型：${s.docType || '未知'}\n概述：${s.overview || '（无）'}\n要点：\n${s.keyPoints.map((p) => `- ${p}`).join('\n') || '（无）'}\n术语：${s.keyTerms.join('、') || '（无）'}\n结构：${s.structure || '（无）'}`
}
