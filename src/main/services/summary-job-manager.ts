import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { EVENTS } from '@shared/ipc'
import type {
  MainToSummaryWorkerMessage,
  SummaryJobKey,
  SummaryProgress,
  SummaryWorkerJob,
  SummaryWorkerResult,
  SummaryWorkerTask,
  SummaryWorkerToMainMessage
} from '@shared/summary-job-protocol'
import { SUMMARY_WORKER_PROTOCOL_VERSION } from '@shared/summary-job-protocol'
import { loadApiSettings } from './api-settings'
import { loadConfig } from './config.service'
import type { AppConfig, DistillResult, DocSummary, ResourceDistillType } from '@shared/types'
import { getUserDataDir } from '../paths'
import { broadcast } from '../window'
import { setSummaryGeneratingState } from './summary-state.service'
import type { ApiSettings } from './api-settings'

interface ActiveJob<T = SummaryWorkerResult> {
  jobId: string
  key: SummaryJobKey
  resolve: (result: T) => void
  reject: (error: Error) => void
}

let worker: UtilityProcess | null = null
let readyPromise: Promise<void> | null = null
let readyResolve: (() => void) | null = null
let readyReject: ((error: Error) => void) | null = null
let runtimeUserDataDir = ''
let shuttingDown = false
let restartCount = 0
const active = new Map<string, ActiveJob>()
const activeByKey = new Map<string, Promise<SummaryWorkerResult>>()
const latestPhaseByJobId = new Map<string, SummaryProgress['phase']>()

function workerError(message: string, name?: string): Error {
  const error = new Error(message)
  if (name) error.name = name
  return error
}

function post(message: MainToSummaryWorkerMessage, target = worker): void {
  if (!target) throw new Error('摘要 Worker 尚未启动')
  target.postMessage(message)
}

function progressWithJob(progress: SummaryProgress): void {
  if (!active.has(progress.jobId)) return
  latestPhaseByJobId.set(progress.jobId, progress.phase)
  broadcast(EVENTS.summaryProgress, progress)
}

function markStarted(key: SummaryJobKey, jobId: string): void {
  setSummaryGeneratingState(key, true)
  broadcast(EVENTS.summaryStatus, { key, generating: true })
  latestPhaseByJobId.set(jobId, 'queued')
  broadcast(EVENTS.summaryProgress, { jobId, key, phase: 'queued', completed: 0, total: 1 })
}

function markFinished(key: SummaryJobKey, jobId: string, phase: 'complete' | 'failed' | 'cancelled'): void {
  latestPhaseByJobId.set(jobId, phase)
  setSummaryGeneratingState(key, false)
  broadcast(EVENTS.summaryProgress, { jobId, key, phase, completed: phase === 'complete' ? 1 : 0, total: 1 })
  broadcast(EVENTS.summaryStatus, { key, generating: false })
  latestPhaseByJobId.delete(jobId)
}

function rejectAll(error: Error): void {
  for (const job of active.values()) {
    markFinished(job.key, job.jobId, 'failed')
    latestPhaseByJobId.delete(job.jobId)
    job.reject(error)
  }
  active.clear()
  activeByKey.clear()
}

function onMessage(message: SummaryWorkerToMainMessage, source: UtilityProcess): void {
  if (!message || message.protocolVersion !== SUMMARY_WORKER_PROTOCOL_VERSION) return
  // A timed-out/terminated process can still deliver a queued message while a
  // replacement worker is starting. Never let that stale process resolve the
  // replacement worker's readiness or complete one of its jobs.
  if (source !== worker) return
  if (message.type === 'ready') {
    readyResolve?.()
    readyResolve = null
    readyReject = null
    return
  }
  if (message.type === 'progress') {
    progressWithJob(message.progress)
    return
  }
  if (message.type === 'fatal') {
    const error = workerError(message.error.message, message.error.name)
    readyReject?.(workerError(String(error)))
    readyResolve = null
    readyReject = null
    rejectAll(error)
    return
  }
  const job = active.get(message.jobId)
  if (!job) return
  active.delete(message.jobId)
  activeByKey.delete(job.key)
  if (message.type === 'completed') {
    const result = message.result
    const isExplicitFailure = Boolean(result && typeof result === 'object' && 'ok' in result && (result as { ok?: unknown }).ok === false)
    const phase = isExplicitFailure || latestPhaseByJobId.get(job.jobId) === 'failed' ? 'failed' : 'complete'
    markFinished(job.key, job.jobId, phase)
    job.resolve(result)
  } else if (message.type === 'cancelled') {
    markFinished(job.key, job.jobId, 'cancelled')
    job.reject(workerError('摘要任务已取消'))
  } else {
    markFinished(job.key, job.jobId, 'failed')
    job.reject(workerError(message.error.message, message.error.name))
  }
}

function onExit(source: UtilityProcess, code: number): void {
  if (source !== worker) return
  const error = workerError(`摘要 Worker 已退出（code=${code}）`)
  worker = null
  readyPromise = null
  readyReject?.(workerError(String(error)))
  readyResolve = null
  readyReject = null
  rejectAll(error)
  if (!shuttingDown && restartCount < 1) {
    restartCount += 1
    void startWorker().catch(() => {})
  }
}

async function startWorker(): Promise<void> {
  if (worker && readyPromise) return readyPromise
  const workerPath = join(__dirname, 'summary-worker.js')
  const child = utilityProcess.fork(workerPath, [], { serviceName: 'summary-worker' })
  worker = child
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  const promise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  readyResolve = resolveReady
  readyReject = rejectReady
  readyPromise = promise
  const timeout = setTimeout(() => {
    if (worker !== child || readyPromise !== promise) return
    worker = null
    readyPromise = null
    readyResolve = null
    readyReject = null
    rejectReady(new Error('摘要 Worker 启动超时'))
    child.kill()
  }, 15000)
  promise.then(() => clearTimeout(timeout), () => clearTimeout(timeout))
  child.on('message', (message) => onMessage(message as SummaryWorkerToMainMessage, child))
  child.on('exit', (code) => onExit(child, code))
  child.on('error', (type, location, report) => {
    if (worker !== child) return
    const error = workerError(`摘要 Worker 发生致命错误：${type}${location ? ` (${location})` : ''}`)
    readyReject?.(error)
    readyResolve = null
    readyReject = null
    void report
  })
  try {
    post({
      type: 'init',
      protocolVersion: SUMMARY_WORKER_PROTOCOL_VERSION,
      runtime: { userDataDir: runtimeUserDataDir }
    }, child)
  } catch (error) {
    clearTimeout(timeout)
    if (worker === child) {
      worker = null
      readyPromise = null
      readyResolve = null
      readyReject = null
    }
    child.kill()
    rejectReady(error as Error)
  }
  return promise
}

export async function initializeSummaryJobManager(): Promise<void> {
  runtimeUserDataDir = getUserDataDir()
  shuttingDown = false
  restartCount = 0
  await startWorker()
}

async function makeJob(key: SummaryJobKey, task: SummaryWorkerTask): Promise<SummaryWorkerJob> {
  const config = await loadConfig()
  const settings: ApiSettings = await loadApiSettings()
  return {
    protocolVersion: SUMMARY_WORKER_PROTOCOL_VERSION,
    jobId: randomUUID(),
    key,
    task,
    config,
    settings
  }
}

export function runSummaryJob<T extends SummaryWorkerResult>(key: SummaryJobKey, task: SummaryWorkerTask): Promise<T> {
  const existing = activeByKey.get(key)
  if (existing) return existing as Promise<T>
  const promise = (async (): Promise<SummaryWorkerResult> => {
    if (shuttingDown) throw new Error('应用正在退出，无法启动摘要任务')
    await startWorker()
    const job = await makeJob(key, task)
    markStarted(key, job.jobId)
    return await new Promise<SummaryWorkerResult>((resolve, reject) => {
      active.set(job.jobId, { jobId: job.jobId, key, resolve, reject })
      try {
        post({ type: 'start', protocolVersion: SUMMARY_WORKER_PROTOCOL_VERSION, job })
      } catch (error) {
        active.delete(job.jobId)
        markFinished(key, job.jobId, 'failed')
        reject(error as Error)
      }
    })
  })()
  activeByKey.set(key, promise)
  void promise.catch(() => {}).finally(() => {
    if (activeByKey.get(key) === promise) activeByKey.delete(key)
  })
  return promise as Promise<T>
}

export function ensureDocSummaryInWorker(projectId: string, docId: string, currentContent: string): Promise<DocSummary | null> {
  return runSummaryJob<DocSummary | null>(`doc:${docId}`, { kind: 'ensure-doc', projectId, docId, currentContent })
}

export function regenerateDocSummaryInWorker(docId: string): Promise<{ ok: boolean; error?: string }> {
  return runSummaryJob<{ ok: boolean; error?: string }>(`doc:${docId}`, { kind: 'regenerate-doc', docId })
}

export function queueChatSummaryInWorker(chatId: string, force = false): Promise<void> {
  return runSummaryJob<void>(`chat:${chatId}`, { kind: 'queue-chat', chatId, force })
}

export function regenerateChatSummaryInWorker(chatId: string): Promise<{ ok: boolean; error?: string }> {
  return runSummaryJob<{ ok: boolean; error?: string }>(`chat:${chatId}`, { kind: 'regenerate-chat', chatId })
}

export function distillResourceInWorker(projectId: string, resourceId: string, type: ResourceDistillType, force = false): Promise<DistillResult> {
  return runSummaryJob<DistillResult>(`res:${resourceId}`, { kind: 'distill-resource', projectId, resourceId, type, force })
}

export function generateDocRollupsInWorker(projectId: string): Promise<{ ok: boolean; error?: string }> {
  return runSummaryJob<{ ok: boolean; error?: string }>(`rollup:${projectId}`, { kind: 'generate-rollups', projectId })
}

export function regenerateDocRollupInWorker(projectId: string, rollupId: string): Promise<{ ok: boolean; error?: string }> {
  return runSummaryJob<{ ok: boolean; error?: string }>(`rollup:${projectId}:${rollupId}`, { kind: 'regenerate-rollup', projectId, rollupId })
}

export function retryPendingSummariesInWorker(): Promise<void> {
  return runSummaryJob<void>('chat:retry-pending' as SummaryJobKey, { kind: 'retry-pending' })
}

export async function waitForSummaryWorker(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (active.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(10, deadline - Date.now()))))
  }
  return active.size === 0
}

export async function shutdownSummaryJobManager(timeoutMs = 8000): Promise<boolean> {
  shuttingDown = true
  const drained = await waitForSummaryWorker(timeoutMs)
  if (worker) {
    try {
      post({ type: 'shutdown', protocolVersion: SUMMARY_WORKER_PROTOCOL_VERSION })
    } catch {
      // Worker may already have exited.
    }
    if (!drained) worker.kill()
  }
  worker = null
  readyPromise = null
  return drained
}

