import { appendFile, mkdir, readdir, rm, stat } from 'fs/promises'
import { join } from 'path'
import { format } from 'date-fns'
import { getUserDataDir } from '../paths'

/** 错误日志：按天一个文件，保留 7 天（一日一清） */
const RETENTION_DAYS = 7

function logsDir(): string {
  return join(getUserDataDir(), 'logs')
}

function todayPath(): string {
  return join(logsDir(), `errors-${format(new Date(), 'yyyy-MM-dd')}.log`)
}

function summaryAttemptsPath(): string {
  return join(logsDir(), `summary-attempts-${format(new Date(), 'yyyy-MM-dd')}.jsonl`)
}

function vectorEventsPath(): string {
  return join(logsDir(), `vector-events-${format(new Date(), 'yyyy-MM-dd')}.jsonl`)
}

let queue: Promise<void> = Promise.resolve()

export function logError(source: string, message: string, stack?: string): void {
  queue = queue.then(async () => {
    try {
      await mkdir(logsDir(), { recursive: true })
      const line = `[${new Date().toISOString()}] [${source}] ${message}${stack ? `\n${stack}` : ''}\n`
      await appendFile(todayPath(), line, 'utf8')
    } catch {
      // 日志失败不抛出，避免影响业务
    }
  })
}

/** 结构化生成审计：不写 API Key、用户原文或模型返回全文，只保留可排障的尝试元数据。 */
export function logStructuredGenerationAttempt(event: {
  task: string
  endpointKey: string
  attempt: number
  mode: string
  compact: boolean
  outcome: 'success' | 'failure'
  durationMs: number
  finishReason?: string | null
  error?: string
}): void {
  queue = queue.then(async () => {
    try {
      await mkdir(logsDir(), { recursive: true })
      await appendFile(summaryAttemptsPath(), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, 'utf8')
    } catch {
      // 日志不能影响摘要主流程
    }
  })
}

/** 向量嵌入审计：不记录项目 ID、查询文本、文档原文或向量，只记录后端状态和性能元数据。 */
export function logVectorEvent(event: {
  stage: 'load' | 'build' | 'search' | 'fallback' | 'dispose'
  backend: string
  outcome: 'success' | 'failure' | 'empty'
  durationMs?: number
  chunkCount?: number
  candidateCount?: number
  hitCount?: number
  topScore?: number
  queryLength?: number
  source?: 'automatic' | 'tool'
  attempt?: number
  sourceKinds?: ('doc' | 'res')[]
  operation?: 'full' | 'incremental' | 'source' | 'remove'
  reason?: string
}): void {
  queue = queue.then(async () => {
    try {
      await mkdir(logsDir(), { recursive: true })
      const safeReason = event.reason?.replace(/\s+/g, ' ').slice(0, 500)
      await appendFile(
        vectorEventsPath(),
        `${JSON.stringify({ at: new Date().toISOString(), ...event, reason: safeReason })}\n`,
        'utf8'
      )
    } catch {
      // 日志不能影响向量检索主流程
    }
  })
}

/**
 * 工具协议审计：只记录协议状态，不记录查询词、工具参数、项目标识或任何原文。
 */
export function logToolProtocolEvent(event: {
  outcome:
    | 'native'
    | 'text-recovered'
    | 'malformed'
    | 'truncated'
    | 'compatibility-retry'
    | 'repair'
    | 'no-tool-fallback'
  finishReason?: string | null
  toolCalls?: number
  durationMs?: number
}): void {
  queue = queue.then(async () => {
    try {
      await mkdir(logsDir(), { recursive: true })
      await appendFile(
        join(logsDir(), `tool-protocol-${format(new Date(), 'yyyy-MM-dd')}.jsonl`),
        `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
        'utf8'
      )
    } catch {
      // 日志不能影响工具调用主流程
    }
  })
}
/** 启动时清理超过保留天数的旧日志文件 */
export async function initErrorLog(): Promise<void> {
  try {
    const files = await readdir(logsDir())
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000
    for (const f of files) {
      try {
        const p = join(logsDir(), f)
        const st = await stat(p)
        if (st.mtimeMs < cutoff) await rm(p, { force: true })
      } catch {
        // 忽略单个文件清理失败
      }
    }
  } catch {
    // 目录不存在等，忽略
  }
}
