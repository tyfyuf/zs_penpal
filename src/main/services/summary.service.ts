import OpenAI from 'openai'
import type { DocSummary, ChatSummary } from '@shared/types'
import { loadApiSettings } from './api-settings'
import { loadConfig } from './config.service'
import { estimateTokens } from './tokenizer'
import { recordUsage } from './usage.service'
import {
  getChat,
  readChatSummary,
  readDoc,
  readDocSummary,
  writeChatSummary,
  writeDocSummary
} from './file.service'
import { readJson, atomicWriteJson, nowIso } from '../util'
import { join } from 'path'
import { getUserDataDir } from '../paths'

// ---------------------------------------------------------------------------
// 摘要系统（PRD 7 / tech-stack 6.12 / 8.5）：
// - 文档摘要（核心冲突 / 角色动机 / 章节功能）
// - 聊天摘要（简短索引标签）
// - 复用主模型配置，独立低温度参数，用量打标 source: 'summary'
// - 串行队列（并发 1），退出时等待或超时
// ---------------------------------------------------------------------------

const DOC_SUMMARY_PROMPT = `你是小说写作助手。请阅读下面的小说正文，输出 JSON（不要输出其他内容），包含三个字段：
- "coreConflict"：一句话概括当前章节/片段的核心冲突；
- "characterMotivation"：一句话概括主要角色的当前动机；
- "chapterFunction"：一句话概括这段内容在整体叙事中的功能。
输出必须是合法 JSON 对象。`

const CHAT_SUMMARY_PROMPT = `请为下面这段写作讨论对话生成一个简短索引标签（不超过 20 字），例如"关于第 3 章的修改建议"。只输出标签文本本身。`

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

// ---------------------------------------------------------------------------
// 文档摘要
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

function parseDocSummary(raw: string): { coreConflict: string; characterMotivation: string; chapterFunction: string } {
  try {
    const match = raw.match(/\{[\s\S]*\}/)
    if (match) {
      const obj = JSON.parse(match[0])
      return {
        coreConflict: String(obj.coreConflict ?? ''),
        characterMotivation: String(obj.characterMotivation ?? ''),
        chapterFunction: String(obj.chapterFunction ?? '')
      }
    }
  } catch {
    // 忽略，走回退
  }
  return { coreConflict: raw, characterMotivation: '', chapterFunction: '' }
}

async function generateDocSummary(projectId: string, docId: string, content: string, model: string): Promise<DocSummary> {
  const cfg = await loadApiSettings()
  if (!cfg.apiKey) throw new Error('未配置 API Key')
  const client = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey })
  const text = content.slice(0, 30000)
  const res = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: DOC_SUMMARY_PROMPT },
      { role: 'user', content: text || '（空文档）' }
    ],
    temperature: 0.3,
    max_tokens: 512
  })
  const raw = res.choices[0]?.message?.content ?? ''
  const parsed = parseDocSummary(raw)
  if (res.usage) await recordUsage(res.usage, 'summary')
  return { ...parsed, snapshotLength: content.length, snapshot: content, updatedAt: nowIso() }
}

/**
 * 静默检测关联文档摘要是否需要更新，并按 PRD 7.3 处理。
 * 返回本次请求应附加的摘要（新摘要或旧摘要），无摘要返回 null。
 */
export async function ensureDocSummary(
  projectId: string,
  docId: string,
  currentContent: string
): Promise<DocSummary | null> {
  const cfg = await loadConfig()
  if (!cfg.summaryEnabled) return null

  const existing = await readDocSummary(projectId, docId)
  if (!existing) {
    // 首次：直接生成
    try {
      const summary = await generateDocSummary(projectId, docId, currentContent, cfg.model)
      await writeDocSummary(projectId, docId, summary)
      return summary
    } catch {
      return null
    }
  }

  const changed = estimateChangedChars(existing.snapshot ?? '', currentContent)
  const netAdded = Math.max(0, currentContent.length - (existing.snapshot?.length ?? 0))
  const ratio = changed / Math.max(existing.snapshotLength, 1)
  const needUpdate = ratio > 0.3 || netAdded > 500

  if (!needUpdate) return existing

  try {
    const summary = await generateDocSummary(projectId, docId, currentContent, cfg.model)
    await writeDocSummary(projectId, docId, summary)
    return summary
  } catch {
    // 失败沿用旧摘要，不阻塞本次请求（PRD 7.3）
    return existing
  }
}

// ---------------------------------------------------------------------------
// 聊天摘要
// ---------------------------------------------------------------------------

async function generateChatSummary(chatId: string): Promise<void> {
  const cfg = await loadApiSettings()
  if (!cfg.apiKey) throw new Error('未配置 API Key')

  const { chat, messages } = await getChat(chatId)
  const userTurns = messages.filter((m) => m.role === 'user').length
  const assistantTurns = messages.filter((m) => m.role === 'assistant').length
  if (userTurns === 0 || assistantTurns === 0) return

  const existing = await readChatSummary(chat.projectId, chatId)
  // 只有出现新消息时才更新（PRD 7.5）
  if (existing && existing.messageCount >= messages.length) return

  const client = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey })
  const dialogue = messages
    .map((m) => `${m.role === 'user' ? '用户' : 'AI'}：${m.content}`)
    .join('\n')
    .slice(0, 6000)
  const res = await client.chat.completions.create({
    model: cfg.model,
    messages: [
      { role: 'system', content: CHAT_SUMMARY_PROMPT },
      { role: 'user', content: dialogue }
    ],
    temperature: 0.3,
    max_tokens: 128
  })
  const label = (res.choices[0]?.message?.content ?? chat.title).trim().slice(0, 20)
  if (res.usage) await recordUsage(res.usage, 'summary')
  await writeChatSummary(chat.projectId, chatId, {
    label,
    updatedAt: nowIso(),
    messageCount: messages.length
  })
}

/** 关闭对话窗口后入队生成聊天摘要（PRD 7.5） */
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

export function getQueuedCount(): number {
  return pendingRetry.size
}

// 供外部获取 token 预算用的估算函数（避免循环依赖）
export { estimateTokens }
