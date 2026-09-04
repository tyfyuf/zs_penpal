/** 编辑器标签页的保存处理器注册表，供关闭标签时落盘未保存内容 */
const handlers = new Map<string, () => Promise<void>>()

export function registerSaveHandler(docId: string, fn: () => Promise<void>): () => void {
  handlers.set(docId, fn)
  return () => {
    handlers.delete(docId)
  }
}

export async function flushDoc(docId: string): Promise<void> {
  const fn = handlers.get(docId)
  if (fn) await fn()
}

export async function flushAll(): Promise<void> {
  const results = await Promise.allSettled([...handlers.values()].map((fn) => fn()))
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failures.length > 0) {
    const messages = failures.map((failure) => failure.reason instanceof Error ? failure.reason.message : String(failure.reason))
    throw new Error(`保存失败：${messages.join('；')}`)
  }
}
