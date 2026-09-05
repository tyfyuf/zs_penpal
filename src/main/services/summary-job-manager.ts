import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { EVENTS, type WorkspaceChangeEntity } from '@shared/ipc'
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
import { notifyWorkspaceChanged } from './workspace-events.service'
import type { ApiSettings } from './api-settings'
import { logError } from './log.service'

interface SummaryJobContext {
  projectId?: string
  entityType?: WorkspaceChangeEntity
  entityId?: string
}

interface SummaryJobControl {
  key: string
  keyGeneration: number
  projectId?: string
  projectGeneration?: number
  retryGeneration?: number
  cancelled: boolean
}

interface ActiveJob<T = SummaryWorkerResult> {
  jobId: string
  key: SummaryJobKey
  context: SummaryJobContext
  control: SummaryJobControl
  cancelRequested: boolean
  resolve: (result: T) => void
  reject: (error: Error) => void
}

interface TrackedSummaryJob {
  task: SummaryWorkerTask
  promise: Promise<SummaryWorkerResult>
  control: SummaryJobControl
}

let worker: UtilityProcess | null = null
let readyPromise: Promise<void> | null = null
let readyResolve: (() => void) | null = null
let readyReject: ((error: Error) => void) | null = null
let runtimeUserDataDir = ''
let shuttingDown = false
let restartCount = 0
const active = new Map<string, ActiveJob>()
const activeByKey = new Map<string, TrackedSummaryJob>()
const latestPhaseByJobId = new Map<string, SummaryProgress['phase']>()
const quiescedProjects = new Map<string, number>()
const quiescedKeys = new Map<string, number>()
const keyCancellationGeneration = new Map<string, number>()
const projectCancellationGeneration = new Map<string, number>()
let retryCancellationGeneration = 0
let queuedCount = 0

function broadcastQueueStatus(): void {
  const activeCount = active.size
  broadcast(EVENTS.summaryQueue, { active: activeCount, queued: queuedCount, total: activeCount + queuedCount })
}

class SummaryJobCancelledError extends Error {
  constructor() {
    super('\u6458\u8981\u4efb\u52a1\u5df2\u53d6\u6d88')
    this.name = 'SummaryJobCancelledError'
  }
}

function cancellationError(): SummaryJobCancelledError {
  return new SummaryJobCancelledError()
}

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

function markStarted(key: SummaryJobKey, jobId: string, context: SummaryJobContext): void {
  setSummaryGeneratingState(key, true)
  broadcast(EVENTS.summaryStatus, { key, generating: true, ...context })
  latestPhaseByJobId.set(jobId, 'queued')
  broadcast(EVENTS.summaryProgress, { jobId, key, phase: 'queued', completed: 0, total: 1 })
}

function markFinished(key: SummaryJobKey, jobId: string, phase: 'complete' | 'failed' | 'waiting-confirmation' | 'cancelled', context: SummaryJobContext): void {
  latestPhaseByJobId.set(jobId, phase)
  setSummaryGeneratingState(key, false)
  broadcast(EVENTS.summaryProgress, { jobId, key, phase, completed: phase === 'complete' ? 1 : 0, total: 1 })
  broadcast(EVENTS.summaryStatus, { key, generating: false, ...context })
  if (phase === 'complete' || phase === 'failed') {
    notifyWorkspaceChanged({ ...context, reason: phase === 'complete' ? 'summary-completed' : 'summary-failed' })
  }
  latestPhaseByJobId.delete(jobId)
}

function rejectAll(error: Error): void {
  // Mark the tail controls first. A serialized chain must not start another
  // worker after a fatal worker failure or process shutdown.
  for (const tracked of activeByKey.values()) tracked.control.cancelled = true
  for (const job of active.values()) {
    job.control.cancelled = true
    markFinished(job.key, job.jobId, 'failed', job.context)
    latestPhaseByJobId.delete(job.jobId)
    job.reject(error)
  }
  active.clear()
  broadcastQueueStatus()
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
  broadcastQueueStatus()
  if (message.type === 'cancelled' || job.cancelRequested || isControlCancelled(job.control)) {
    markFinished(job.key, job.jobId, 'cancelled', job.context)
    job.reject(cancellationError())
  } else if (message.type === 'completed') {
    const result = message.result
    const isConfirmationRequired = Boolean(
      result &&
      typeof result === 'object' &&
      'ok' in result &&
      (result as { ok?: unknown }).ok === false &&
      (((result as { mismatch?: unknown }).mismatch === true) || ((result as { uncertain?: unknown }).uncertain === true))
    )
    const isExplicitFailure = Boolean(result && typeof result === 'object' && 'ok' in result && (result as { ok?: unknown }).ok === false)
    const phase = isConfirmationRequired
      ? 'waiting-confirmation'
      : isExplicitFailure || latestPhaseByJobId.get(job.jobId) === 'failed'
        ? 'failed'
        : 'complete'
    markFinished(job.key, job.jobId, phase, job.context)
    job.resolve(result)
  } else {
    markFinished(job.key, job.jobId, 'failed', job.context)
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
  // The manager is bundled into out/main/chunks/summary.service-*.js, while
  // the utility-process entry remains at out/main/summary-worker.js.
  const workerPath = join(__dirname, '..', 'summary-worker.js')
  const child = utilityProcess.fork(workerPath, [], {
    serviceName: 'summary-worker',
    // Keep Worker diagnostics observable. Without piped stderr a startup
    // exception is reduced to the opaque "code=1" message in the main log.
    stdio: ['ignore', 'pipe', 'pipe']
  })
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
  child.stdout?.on('data', (chunk) => {
    const text = chunk.toString().trim()
    if (text) logError('summary-worker:stdout', text)
  })
  child.stderr?.on('data', (chunk) => {
    const text = chunk.toString().trim()
    if (text) logError('summary-worker:stderr', text)
  })
  child.on('message', (message) => onMessage(message as SummaryWorkerToMainMessage, child))
  child.on('exit', (code) => onExit(child, code))
  child.on('error', (type, location, report) => {
    if (worker !== child) return
    const error = workerError(`摘要 Worker 发生致命错误：${type}${location ? ` (${location})` : ''}`)
    readyReject?.(error)
    readyResolve = null
    readyReject = null
    if (report) logError('summary-worker:fatal', report)
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
  quiescedProjects.clear()
  quiescedKeys.clear()
  keyCancellationGeneration.clear()
  projectCancellationGeneration.clear()
  retryCancellationGeneration = 0
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

function projectIdForTask(task: SummaryWorkerTask): string | undefined {
  return 'projectId' in task && typeof task.projectId === 'string' ? task.projectId : undefined
}

function isRetryPendingTask(task: SummaryWorkerTask): boolean {
  return task.kind === 'retry-pending'
}

function currentGeneration(store: Map<string, number>, key: string): number {
  return store.get(key) ?? 0
}

function captureJobControl(key: SummaryJobKey, task: SummaryWorkerTask): SummaryJobControl {
  const projectId = projectIdForTask(task)
  return {
    key,
    keyGeneration: currentGeneration(keyCancellationGeneration, key),
    projectId,
    projectGeneration: projectId ? currentGeneration(projectCancellationGeneration, projectId) : undefined,
    retryGeneration: isRetryPendingTask(task) ? retryCancellationGeneration : undefined,
    cancelled: false
  }
}

function isControlCancelled(control: SummaryJobControl): boolean {
  if (control.cancelled) return true
  if (currentGeneration(keyCancellationGeneration, control.key) > control.keyGeneration) return true
  if (control.projectId && currentGeneration(projectCancellationGeneration, control.projectId) > (control.projectGeneration ?? 0)) return true
  if (control.retryGeneration !== undefined && retryCancellationGeneration > control.retryGeneration) return true
  return false
}

function assertSummaryJobCanEnter(key: SummaryJobKey, task: SummaryWorkerTask): void {
  if (shuttingDown) throw new Error('\u5e94\u7528\u6b63\u5728\u9000\u51fa\uff0c\u65e0\u6cd5\u542f\u52a8\u6458\u8981\u4efb\u52a1')
  if (quiescedKeys.has(key)) throw new Error('\u8be5\u6458\u8981\u4efb\u52a1\u6b63\u5728\u8fdb\u884c\u751f\u547d\u5468\u671f\u64cd\u4f5c\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5')
  const projectId = projectIdForTask(task)
  if (projectId && quiescedProjects.has(projectId)) {
    throw new Error('\u8be5\u9879\u76ee\u6b63\u5728\u8fdb\u884c\u751f\u547d\u5468\u671f\u64cd\u4f5c\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5')
  }
  // retry-pending scans all projects and therefore cannot safely enter while
  // any project is quiesced. Later batches may make the retry sweep scoped.
  if (isRetryPendingTask(task) && quiescedProjects.size > 0) {
    throw new Error('\u9879\u76ee\u751f\u547d\u5468\u671f\u64cd\u4f5c\u8fdb\u884c\u4e2d\uff0c\u6682\u4e0d\u80fd\u542f\u52a8\u6458\u8981\u91cd\u8bd5\u626b\u63cf')
  }
}

function assertSummaryJobCanStart(key: SummaryJobKey, task: SummaryWorkerTask, control: SummaryJobControl): void {
  if (isControlCancelled(control)) throw cancellationError()
  assertSummaryJobCanEnter(key, task)
}

function decrementQueuedCount(): void {
  queuedCount = Math.max(0, queuedCount - 1)
  broadcastQueueStatus()
}

function contextForTask(key: SummaryJobKey, task: SummaryWorkerTask): SummaryJobContext {
  const [kind, id] = key.split(':', 2)
  const entityType: WorkspaceChangeEntity | undefined = kind === 'doc' || kind === 'chat' || kind === 'res' || kind === 'rollup'
    ? (kind === 'res' ? 'resource' : kind)
    : undefined
  const projectId = projectIdForTask(task)
  return {
    projectId,
    entityType,
    entityId: kind === 'rollup' ? projectId ?? id : id
  }
}

function createSummaryJobPromise(
  key: SummaryJobKey,
  task: SummaryWorkerTask,
  control: SummaryJobControl,
  alreadyTracked = false
): Promise<SummaryWorkerResult> {
  if (!alreadyTracked) {
    queuedCount++
    broadcastQueueStatus()
  }
  let promoted = false
  const promise = (async (): Promise<SummaryWorkerResult> => {
    try {
      assertSummaryJobCanStart(key, task, control)
      await startWorker()
      assertSummaryJobCanStart(key, task, control)
      const job = await makeJob(key, task)
      assertSummaryJobCanStart(key, task, control)
      const context = contextForTask(key, task)
      decrementQueuedCount()
      promoted = true
      active.set(job.jobId, {
        jobId: job.jobId,
        key,
        context,
        control,
        cancelRequested: false,
        resolve: () => {},
        reject: () => {}
      })
      broadcastQueueStatus()
      markStarted(key, job.jobId, context)
      return await new Promise<SummaryWorkerResult>((resolve, reject) => {
        const current = active.get(job.jobId)
        if (current) {
          current.resolve = resolve
          current.reject = reject
        }
        try {
          post({ type: 'start', protocolVersion: SUMMARY_WORKER_PROTOCOL_VERSION, job })
        } catch (error) {
          active.delete(job.jobId)
          markFinished(key, job.jobId, 'failed', context)
          broadcastQueueStatus()
          reject(error as Error)
        }
      })
    } finally {
      if (!promoted) decrementQueuedCount()
    }
  })()
  return promise
}

function trackSummaryJob(key: SummaryJobKey, task: SummaryWorkerTask, promise: Promise<SummaryWorkerResult>, control: SummaryJobControl): Promise<SummaryWorkerResult> {
  activeByKey.set(key, { task, promise, control })
  void promise.catch(() => {}).finally(() => {
    if (activeByKey.get(key)?.promise === promise) {
      activeByKey.delete(key)
      broadcastQueueStatus()
    }
  })
  return promise
}

function canJoinSummaryJob(existing: SummaryWorkerTask, requested: SummaryWorkerTask): boolean {
  if (existing.kind !== requested.kind) return false
  if (existing.kind === 'regenerate-rollup' && requested.kind === 'regenerate-rollup') {
    return existing.rollupId === requested.rollupId
  }
  return true
}

export function runSummaryJob<T extends SummaryWorkerResult>(key: SummaryJobKey, task: SummaryWorkerTask): Promise<T> {
  try {
    assertSummaryJobCanEnter(key, task)
  } catch (error) {
    return Promise.reject(error) as Promise<T>
  }

  const existing = activeByKey.get(key)
  if (!existing) {
    const control = captureJobControl(key, task)
    return trackSummaryJob(key, task, createSummaryJobPromise(key, task, control), control) as Promise<T>
  }
  if (canJoinSummaryJob(existing.task, task) && !isControlCancelled(existing.control)) {
    return existing.promise as Promise<T>
  }

  // Different operations for the same source must remain serialized. Keep the
  // chained promise in activeByKey immediately, so a third request joins the
  // tail instead of starting a second operation concurrently after the first
  // one completes. The reservation is released if cancellation prevents the
  // tail from being created.
  const control = captureJobControl(key, task)
  queuedCount++
  broadcastQueueStatus()
  const releaseReservation = (): void => decrementQueuedCount()
  const startTail = (): Promise<SummaryWorkerResult> => {
    if (isControlCancelled(control)) {
      releaseReservation()
      return Promise.reject(cancellationError())
    }
    return createSummaryJobPromise(key, task, control, true)
  }
  const chained = existing.promise.then(
    () => startTail(),
    () => startTail()
  )
  return trackSummaryJob(key, task, chained, control) as Promise<T>
}

export function ensureDocSummaryInWorker(projectId: string, docId: string, currentContent: string): Promise<DocSummary | null> {
  return runSummaryJob<DocSummary | null>(`doc:${docId}`, { kind: 'ensure-doc', projectId, docId, currentContent })
}

export function regenerateDocSummaryInWorker(projectId: string, docId: string, forceFull = false): Promise<{ ok: boolean; error?: string }> {
  return runSummaryJob<{ ok: boolean; error?: string }>(`doc:${docId}`, { kind: 'regenerate-doc', projectId, docId, forceFull })
}

export function queueChatSummaryInWorker(projectId: string, chatId: string, force = false): Promise<void> {
  return runSummaryJob<void>(`chat:${chatId}`, { kind: 'queue-chat', projectId, chatId, force })
}

export function regenerateChatSummaryInWorker(projectId: string, chatId: string): Promise<{ ok: boolean; error?: string }> {
  return runSummaryJob<{ ok: boolean; error?: string }>(`chat:${chatId}`, { kind: 'regenerate-chat', projectId, chatId })
}

export function distillResourceInWorker(projectId: string, resourceId: string, type: ResourceDistillType, force = false): Promise<DistillResult> {
  return runSummaryJob<DistillResult>(`res:${resourceId}`, { kind: 'distill-resource', projectId, resourceId, type, force })
}

export function generateDocRollupsInWorker(projectId: string): Promise<{ ok: boolean; error?: string }> {
  return runSummaryJob<{ ok: boolean; error?: string }>(`rollup:${projectId}`, { kind: 'generate-rollups', projectId })
}

export function regenerateDocRollupInWorker(projectId: string, rollupId: string): Promise<{ ok: boolean; error?: string }> {
  return runSummaryJob<{ ok: boolean; error?: string }>(`rollup:${projectId}`, { kind: 'regenerate-rollup', projectId, rollupId })
}

export function retryPendingSummariesInWorker(): Promise<void> {
  return runSummaryJob<void>('chat:retry-pending' as SummaryJobKey, { kind: 'retry-pending' })
}

function requestCancellation(job: ActiveJob): void {
  if (job.cancelRequested) return
  job.cancelRequested = true
  try {
    post({ type: 'cancel', protocolVersion: SUMMARY_WORKER_PROTOCOL_VERSION, jobId: job.jobId })
  } catch {
    // Worker exit is handled by onExit; the job remains tracked until then.
  }
}

function taskBelongsToProject(task: SummaryWorkerTask, projectId: string): boolean {
  return projectIdForTask(task) === projectId
}

function hasPendingSummaryJob(key: string): boolean {
  return activeByKey.has(key) || [...active.values()].some((job) => job.key === key)
}

function hasPendingProjectJob(projectId: string): boolean {
  return [...activeByKey.values()].some(({ task }) => taskBelongsToProject(task, projectId) || isRetryPendingTask(task))
    || [...active.values()].some((job) => job.context.projectId === projectId || job.key === 'chat:retry-pending')
}

export function quiesceSummaryJob(key: SummaryJobKey): void {
  quiescedKeys.set(key, (quiescedKeys.get(key) ?? 0) + 1)
}

export function resumeSummaryJob(key: SummaryJobKey): void {
  const count = quiescedKeys.get(key) ?? 0
  if (count <= 1) quiescedKeys.delete(key)
  else quiescedKeys.set(key, count - 1)
}

export function quiesceProject(projectId: string): void {
  quiescedProjects.set(projectId, (quiescedProjects.get(projectId) ?? 0) + 1)
}

export function resumeProject(projectId: string): void {
  const count = quiescedProjects.get(projectId) ?? 0
  if (count <= 1) quiescedProjects.delete(projectId)
  else quiescedProjects.set(projectId, count - 1)
}

export function cancelSummaryJob(key: SummaryJobKey): void {
  keyCancellationGeneration.set(key, currentGeneration(keyCancellationGeneration, key) + 1)
  const tracked = activeByKey.get(key)
  if (tracked) tracked.control.cancelled = true
  for (const job of active.values()) {
    if (job.key !== key) continue
    job.control.cancelled = true
    requestCancellation(job)
  }
}

export function cancelProjectJobs(projectId: string): void {
  projectCancellationGeneration.set(projectId, currentGeneration(projectCancellationGeneration, projectId) + 1)
  retryCancellationGeneration += 1
  for (const tracked of activeByKey.values()) {
    if (taskBelongsToProject(tracked.task, projectId) || isRetryPendingTask(tracked.task)) tracked.control.cancelled = true
  }
  for (const job of active.values()) {
    if (job.context.projectId === projectId || job.key === 'chat:retry-pending') {
      job.control.cancelled = true
      requestCancellation(job)
    }
  }
}

export async function drainSummaryJob(key: SummaryJobKey, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (hasPendingSummaryJob(key) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(10, deadline - Date.now()))))
  }
  return !hasPendingSummaryJob(key)
}

export async function drainProject(projectId: string, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (hasPendingProjectJob(projectId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(10, deadline - Date.now()))))
  }
  return !hasPendingProjectJob(projectId)
}

export async function waitForSummaryWorker(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while ((active.size > 0 || activeByKey.size > 0 || queuedCount > 0) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(10, deadline - Date.now()))))
  }
  return active.size === 0 && activeByKey.size === 0 && queuedCount === 0
}

export async function shutdownSummaryJobManager(timeoutMs = 8000): Promise<boolean> {
  shuttingDown = true
  for (const tracked of activeByKey.values()) tracked.control.cancelled = true
  for (const job of active.values()) {
    job.control.cancelled = true
    requestCancellation(job)
  }
  const drained = await waitForSummaryWorker(timeoutMs)
  if (worker) {
    try {
      post({ type: 'shutdown', protocolVersion: SUMMARY_WORKER_PROTOCOL_VERSION })
    } catch {
      // Worker may already have exited.
    }
    if (!drained) {
      worker.kill()
      rejectAll(workerError('\u6458\u8981 Worker \u6392\u7a7a\u8d85\u65f6'))
    }
  }
  worker = null
  readyPromise = null
  quiescedProjects.clear()
  quiescedKeys.clear()
  return drained
}

/**
 * Prevent summary workers from reading/writing a project while a destructive
 * lifecycle operation updates its files. The operation is rejected if active
 * workers cannot drain within the bounded grace period.
 */
export async function withSummaryProjectQuiesced<T>(
  projectId: string,
  operation: () => Promise<T>,
  timeoutMs = 15000
): Promise<T> {
  quiesceProject(projectId)
  cancelProjectJobs(projectId)
  const drained = await drainProject(projectId, timeoutMs)
  if (!drained) {
    resumeProject(projectId)
    throw new Error('摘要任务仍在运行，无法安全执行项目文件操作，请稍后重试')
  }
  try {
    return await operation()
  } finally {
    resumeProject(projectId)
  }
}
