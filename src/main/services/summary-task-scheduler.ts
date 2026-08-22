export type SummaryTaskPriority = 'interactive' | 'normal' | 'batch'

interface QueuedTask {
  priority: SummaryTaskPriority
  order: number
  run: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
}

const BASE_CONCURRENCY = 3
const PRIORITY_WEIGHT: Record<SummaryTaskPriority, number> = {
  interactive: 0,
  normal: 1,
  batch: 2
}

let active = 0
let currentLimit = BASE_CONCURRENCY
let order = 0
let rateLimitedUntil = 0
let recoverySuccesses = 0
const queue: QueuedTask[] = []

function sortQueue(): void {
  queue.sort((a, b) => PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority] || a.order - b.order)
}

function drain(): void {
  sortQueue()
  while (active < currentLimit && queue.length > 0) {
    const item = queue.shift()!
    active++
    void item.run().then(item.resolve, item.reject).finally(() => {
      active--
      drain()
    })
  }
}

/**
 * Shared summary scheduler. The setting-v2 pipeline uses three concurrent
 * semantic roles while existing sequential callers keep their current order.
 */
export function scheduleSummaryTask<T>(
  task: () => Promise<T>,
  priority: SummaryTaskPriority = 'normal'
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({
      priority,
      order: order++,
      run: task,
      resolve: (value) => resolve(value as T),
      reject
    })
    drain()
  })
}

/** Temporarily reduce concurrency after an endpoint reports rate limiting. */
export function noteSummaryRateLimit(): void {
  currentLimit = Math.max(1, currentLimit - 1)
  rateLimitedUntil = Date.now() + 60_000
  recoverySuccesses = 0
}

/** Slowly restore concurrency after the endpoint has remained healthy. */
export function noteSummaryRequestSuccess(): void {
  if (currentLimit >= BASE_CONCURRENCY || Date.now() < rateLimitedUntil) return
  recoverySuccesses++
  if (recoverySuccesses < 6) return
  currentLimit++
  recoverySuccesses = 0
  drain()
}

export function summarySchedulerSnapshot(): { active: number; queued: number; limit: number } {
  return { active, queued: queue.length, limit: currentLimit }
}
