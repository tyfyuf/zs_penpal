import type { ApiProtocol, AppConfig, ChatSummary, DistillResult, DocSummary, ResourceDistillType, ResourceSummary } from '@shared/types'

export const SUMMARY_WORKER_PROTOCOL_VERSION = 1 as const

export type SummaryJobKey = `doc:${string}` | `chat:${string}` | `res:${string}` | `rollup:${string}`

export type SummaryProgressPhase =
  | 'queued'
  | 'starting'
  | 'reading'
  | 'classifying'
  | 'chunking'
  | 'extracting'
  | 'merging'
  | 'overview'
  | 'writing'
  | 'complete'
  | 'failed'
  | 'waiting-confirmation'
  | 'cancelled'

export interface SummaryProgress {
  jobId: string
  key: string
  phase: SummaryProgressPhase
  completed: number
  total: number
  detail?: string
}

export interface SummaryQueueStatus {
  active: number
  queued: number
  total: number
}

export type SummaryReadinessPhase = 'checking' | 'generating' | 'ready' | 'failed'

/** Aggregated progress for summaries required before a chat request can call the LLM. */
export interface SummaryReadinessProgress {
  requestId: string
  chatId: string
  phase: SummaryReadinessPhase
  completed: number
  total: number
  currentTitle?: string
  currentKey?: string
  error?: string
}


export interface SummaryWorkerRuntimeConfig {
  userDataDir: string
}

export interface SummaryWorkerApiSettings {
  baseURL: string
  apiProtocol: ApiProtocol
  apiKey: string | null
  model: string
  contextLimit: number
  language: 'zh' | 'en'
}

export type SummaryWorkerTask =
  | { kind: 'ensure-doc'; projectId: string; docId: string; currentContent: string }
  | { kind: 'regenerate-doc'; projectId: string; docId: string; forceFull?: boolean }
  | { kind: 'queue-chat'; projectId: string; chatId: string; force?: boolean }
  | { kind: 'regenerate-chat'; projectId: string; chatId: string }
  | { kind: 'distill-resource'; projectId: string; resourceId: string; type: ResourceDistillType; force?: boolean }
  | { kind: 'generate-rollups'; projectId: string }
  | { kind: 'regenerate-rollup'; projectId: string; rollupId: string }
  | { kind: 'retry-pending' }

export interface SummaryWorkerJob {
  protocolVersion: typeof SUMMARY_WORKER_PROTOCOL_VERSION
  jobId: string
  key: SummaryJobKey
  task: SummaryWorkerTask
  config: AppConfig
  settings: SummaryWorkerApiSettings
}

export type SummaryWorkerResult =
  | DocSummary
  | ChatSummary
  | ResourceSummary
  | DistillResult
  | { ok: boolean; error?: string }
  | null
  | void

export type SummaryWorkerError = {
  message: string
  name?: string
  code?: string
}

export type MainToSummaryWorkerMessage =
  | { type: 'init'; protocolVersion: typeof SUMMARY_WORKER_PROTOCOL_VERSION; runtime: SummaryWorkerRuntimeConfig }
  | { type: 'start'; protocolVersion: typeof SUMMARY_WORKER_PROTOCOL_VERSION; job: SummaryWorkerJob }
  | { type: 'cancel'; protocolVersion: typeof SUMMARY_WORKER_PROTOCOL_VERSION; jobId: string }
  | { type: 'shutdown'; protocolVersion: typeof SUMMARY_WORKER_PROTOCOL_VERSION }

export type SummaryWorkerToMainMessage =
  | { type: 'ready'; protocolVersion: typeof SUMMARY_WORKER_PROTOCOL_VERSION }
  | { type: 'progress'; protocolVersion: typeof SUMMARY_WORKER_PROTOCOL_VERSION; progress: SummaryProgress }
  | { type: 'completed'; protocolVersion: typeof SUMMARY_WORKER_PROTOCOL_VERSION; jobId: string; key: SummaryJobKey; result: SummaryWorkerResult }
  | { type: 'failed'; protocolVersion: typeof SUMMARY_WORKER_PROTOCOL_VERSION; jobId: string; key: SummaryJobKey; error: SummaryWorkerError }
  | { type: 'cancelled'; protocolVersion: typeof SUMMARY_WORKER_PROTOCOL_VERSION; jobId: string; key: SummaryJobKey }
  | { type: 'fatal'; protocolVersion: typeof SUMMARY_WORKER_PROTOCOL_VERSION; error: SummaryWorkerError }

