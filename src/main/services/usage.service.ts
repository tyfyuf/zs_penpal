import { join } from 'path'
import { format } from 'date-fns'
import type { LifetimeUsage, UsageMonth, UsageSnapshot } from '@shared/types'
import { usageDir } from '../paths'
import { atomicWriteJson, readJson } from '../util'

export type UsageSource = 'chat' | 'summary'

interface CompletionUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

function monthPath(month: string): string {
  return join(usageDir(), `${month}.json`)
}

function lifetimePath(): string {
  return join(usageDir(), 'lifetime.json')
}

/** 主进程串行读改写队列，避免并发写丢数据 */
let queue: Promise<void> = Promise.resolve()

/**
 * 记录一次 API 用量（PRD 8.5 / T-4）：
 * - 按月分文件、按小时稀疏聚合、lifetime 独立累计。
 * - 响应缺少 usage 时计入 uncounted，不进图表。
 * - 摘要/标题生成（source='summary'）单独累计 summary 字段，供图表第二折线展示占比。
 */
export function recordUsage(usage: CompletionUsage | undefined, source: UsageSource): Promise<void> {
  queue = queue.then(() => doRecord(usage, source)).catch(() => {})
  return queue
}

async function doRecord(usage: CompletionUsage | undefined, source: UsageSource): Promise<void> {
  const now = new Date()
  const month = format(now, 'yyyy-MM')
  const dateKey = format(now, 'yyyy-MM-dd')
  const hourKey = format(now, 'HH')

  const file = monthPath(month)
  const d = (await readJson<UsageMonth>(file)) ?? { month, days: {} }
  const day = d.days[dateKey] ?? {
    total: { prompt: 0, completion: 0, total: 0 },
    hours: {},
    bySource: {},
    uncounted: 0
  }

  if (!usage) {
    day.uncounted += 1
  } else {
    const hour = day.hours[hourKey] ?? { prompt: 0, completion: 0, total: 0, calls: 0, summary: 0 }
    day.total.prompt += usage.prompt_tokens
    day.total.completion += usage.completion_tokens
    day.total.total += usage.total_tokens
    hour.prompt += usage.prompt_tokens
    hour.completion += usage.completion_tokens
    hour.total += usage.total_tokens
    hour.calls = (hour.calls ?? 0) + 1
    if (source === 'summary') {
      hour.summary = (hour.summary ?? 0) + usage.total_tokens
    }
    day.hours[hourKey] = hour
    day.bySource[source] = day.bySource[source] ?? { total: 0 }
    day.bySource[source].total += usage.total_tokens
  }
  d.days[dateKey] = day
  await atomicWriteJson(file, d)

  const lf = (await readJson<LifetimeUsage>(lifetimePath())) ?? {
    prompt: 0,
    completion: 0,
    total: 0,
    uncounted: 0,
    summary: 0
  }
  if (!usage) {
    lf.uncounted += 1
  } else {
    lf.prompt += usage.prompt_tokens
    lf.completion += usage.completion_tokens
    lf.total += usage.total_tokens
    if (source === 'summary') {
      lf.summary = (lf.summary ?? 0) + usage.total_tokens
    }
  }
  await atomicWriteJson(lifetimePath(), lf)
}

export async function getSnapshot(): Promise<UsageSnapshot> {
  const now = new Date()

  // 近 30 天：最多跨 2 个月文件
  const last30Days: UsageSnapshot['last30Days'] = []
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const key = format(d, 'yyyy-MM-dd')
    const monthData = await readJson<UsageMonth>(monthPath(format(d, 'yyyy-MM')))
    const day = monthData?.days?.[key]
    last30Days.push({
      date: key,
      total: day?.total.total ?? 0,
      prompt: day?.total.prompt ?? 0,
      completion: day?.total.completion ?? 0,
      summary: day?.bySource?.summary?.total ?? 0
    })
  }

  // 当日逐小时
  const todayKey = format(now, 'yyyy-MM-dd')
  const thisMonth = await readJson<UsageMonth>(monthPath(format(now, 'yyyy-MM')))
  const todayData = thisMonth?.days?.[todayKey]
  const today: UsageSnapshot['today'] = []
  for (let h = 0; h < 24; h++) {
    const hk = String(h).padStart(2, '0')
    const bucket = todayData?.hours?.[hk]
    today.push({
      hour: hk,
      total: bucket?.total ?? 0,
      prompt: bucket?.prompt ?? 0,
      completion: bucket?.completion ?? 0,
      summary: bucket?.summary ?? 0
    })
  }

  const lifetime = (await readJson<LifetimeUsage>(lifetimePath())) ?? {
    prompt: 0,
    completion: 0,
    total: 0,
    uncounted: 0,
    summary: 0
  }

  return {
    last30Days,
    today,
    todayTotal: todayData?.total.total ?? 0,
    todaySummary: todayData?.bySource?.summary?.total ?? 0,
    lifetime,
    uncounted: lifetime.uncounted
  }
}
