import type { SummaryProgress } from '@shared/summary-job-protocol'

const generatingKeys = new Map<string, number>()
let progressSink: ((progress: Omit<SummaryProgress, 'jobId'>) => void) | null = null

export function setSummaryProgressSink(sink: ((progress: Omit<SummaryProgress, 'jobId'>) => void) | null): void {
  progressSink = sink
}

export function isSummaryGenerating(key: string): boolean {
  return generatingKeys.has(key)
}

export function setSummaryGeneratingState(key: string, generating: boolean): void {
  if (generating) generatingKeys.set(key, Date.now())
  else generatingKeys.delete(key)
}

export function reportSummaryProgress(key: string, phase: SummaryProgress['phase'], completed = 0, total = 0, detail?: string): void {
  progressSink?.({ key, phase, completed, total, detail })
}
