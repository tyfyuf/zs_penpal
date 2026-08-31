import { randomUUID } from 'crypto'
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { dirname } from 'path'

/** 生成唯一 ID */
export function newId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 24)
}

export function nowIso(): string {
  return new Date().toISOString()
}

/**
 * 原子写入：先写临时文件再 rename，避免进程中断留下半写文件（PRD 1.6 / C10）。
 * - Windows 上同一文件高频写入时 rename 可能因并发冲突报 EPERM：
 *   按文件串行化 + EPERM 退避重试，彻底避免滑块快速拖动导致的报错。
 */
const writeQueues = new Map<string, Promise<void>>()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function atomicWriteRaw(filePath: string, content: string | Uint8Array, encoding: BufferEncoding): Promise<void> {
  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true })
  const tmp = `${filePath}.${newId()}.tmp`
  await writeFile(tmp, content, typeof content === 'string' ? { encoding } : undefined)
  try {
    await rename(tmp, filePath)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

export async function atomicWrite(filePath: string, content: string | Uint8Array, encoding: BufferEncoding = 'utf8'): Promise<void> {
  // 同一文件串行写入
  const prev = writeQueues.get(filePath) ?? Promise.resolve()
  const next = prev.then(async () => {
    // EPERM 退避重试（Windows rename 竞争）
    for (let attempt = 0; ; attempt++) {
      try {
        await atomicWriteRaw(filePath, content, encoding)
        return
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EPERM' && attempt < 5) {
          await sleep(60 + attempt * 80)
          continue
        }
        throw err
      }
    }
  })
  // 失败后允许后续写入继续
  writeQueues.set(filePath, next.catch(() => {}))
  await next
}

export async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  await atomicWrite(filePath, JSON.stringify(data, null, 2))
}

/** 读取 JSON 文件，不存在返回 null */
export async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** 读取 JSONL，每行一个事件（对话事件流），损坏行跳过 */
export async function readJsonl<T>(filePath: string): Promise<T[]> {
  try {
    const raw = await readFile(filePath, 'utf8')
    return raw
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        try {
          return JSON.parse(l) as T
        } catch {
          return null
        }
      })
      .filter((x): x is T => x !== null)
  } catch {
    return []
  }
}

/** 向 JSONL 追加一行 */
export async function appendJsonl(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await appendFile(filePath, JSON.stringify(data) + '\n', 'utf8')
}

/** 简单防抖（用于自动保存等场景） */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, wait: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  return (...args: A) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn(...args)
    }, wait)
  }
}

/** 字符串中文字符数（PRD 6.7 的“字数”展示） */
export function countChars(text: string): number {
  return [...text].length
}
