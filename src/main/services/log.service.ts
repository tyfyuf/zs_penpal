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
