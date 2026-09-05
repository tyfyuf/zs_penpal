const parentPort = process.parentPort
import type { MainToSummaryWorkerMessage, SummaryWorkerJob, SummaryWorkerResult, SummaryWorkerToMainMessage } from '@shared/summary-job-protocol'
import { SUMMARY_WORKER_PROTOCOL_VERSION } from '@shared/summary-job-protocol'
import { setUserDataDir } from '../paths'
import { setConfigCache } from './config.service'
import { setRuntimeApiSettings } from './api-settings'
import {
  distillResource,
  ensureDocSummary,
  generateDocRollups,
  queueChatSummary,
  regenerateChatSummary,
  regenerateDocRollup,
  regenerateDocSummary,
  retryPendingSummaries
} from './summary.service'
import { setSummaryProgressSink } from './summary-state.service'

if (!parentPort) throw new Error('Summary worker must be started as an Electron utility process')

let runtimeUserDataDir = ''
const running = new Map<string, { key: string; controller: AbortController; cancelled: boolean }>()

function send(message: SummaryWorkerToMainMessage): void {
  parentPort?.postMessage(message)
}

function errorPayload(error: unknown): { message: string; name?: string; code?: string } {
  const value = error as { message?: unknown; name?: unknown; code?: unknown }
  return {
    message: typeof value?.message === 'string' ? value.message : String(error),
    name: typeof value?.name === 'string' ? value.name : undefined,
    code: typeof value?.code === 'string' ? value.code : undefined
  }
}

function phaseForTask(job: SummaryWorkerJob): 'reading' | 'classifying' | 'chunking' | 'extracting' | 'merging' | 'overview' {
  if (job.task.kind === 'distill-resource') return job.task.force ? 'extracting' : 'classifying'
  if (job.task.kind === 'generate-rollups' || job.task.kind === 'regenerate-rollup') return 'merging'
  if (job.task.kind === 'queue-chat' || job.task.kind === 'regenerate-chat') return 'extracting'
  return 'reading'
}

class SummaryWorkerCancelledError extends Error {
  constructor() {
    super('Summary worker job cancelled')
    this.name = 'SummaryWorkerCancelledError'
  }
}

function isCancellationError(error: unknown): boolean {
  return error instanceof SummaryWorkerCancelledError || (error as { name?: unknown } | null)?.name === 'SummaryWorkerCancelledError'
}

async function execute(job: SummaryWorkerJob): Promise<SummaryWorkerResult> {
  setConfigCache(job.config)
  setRuntimeApiSettings(job.settings)
  const state = { key: job.key, controller: new AbortController(), cancelled: false }
  running.set(job.jobId, state)
  send({
    type: 'progress',
    protocolVersion: SUMMARY_WORKER_PROTOCOL_VERSION,
    progress: { jobId: job.jobId, key: job.key, phase: phaseForTask(job), completed: 0, total: 1 }
  })
  try {
    let result: SummaryWorkerResult
    switch (job.task.kind) {
      case 'ensure-doc':
        result = await ensureDocSummary(job.task.projectId, job.task.docId, job.task.currentContent)
        break
      case 'regenerate-doc':
        result = await regenerateDocSummary(job.task.projectId, job.task.docId, job.task.forceFull ?? false)
        break
      case 'queue-chat':
        await queueChatSummary(job.task.projectId, job.task.chatId, job.task.force ?? false)
        result = undefined
        break
      case 'regenerate-chat':
        result = await regenerateChatSummary(job.task.projectId, job.task.chatId)
        break
      case 'distill-resource':
        result = await distillResource(job.task.projectId, job.task.resourceId, job.task.type, job.task.force ?? false)
        break
      case 'generate-rollups':
        result = await generateDocRollups(job.task.projectId, job.key)
        break
      case 'regenerate-rollup':
        result = await regenerateDocRollup(job.task.projectId, job.task.rollupId, job.key)
        break
      case 'retry-pending':
        await retryPendingSummaries()
        result = undefined
        break
    }
    if (state.cancelled) throw new SummaryWorkerCancelledError()
    return result
  } catch (error) {
    if (state.cancelled) throw new SummaryWorkerCancelledError()
    throw error
  } finally {
    running.delete(job.jobId)
  }
}

setSummaryProgressSink((progress) => {
  const current = [...running.entries()].find(([, value]) => value.key === progress.key)
  if (!current) return
  const job = current[0]
  send({
    type: 'progress',
    protocolVersion: SUMMARY_WORKER_PROTOCOL_VERSION,
    progress: { jobId: job, ...progress }
  })
})

parentPort.on('message', (event) => {
  const message = event.data as MainToSummaryWorkerMessage
  if (!message || message.protocolVersion !== SUMMARY_WORKER_PROTOCOL_VERSION) return
  if (message.type === 'init') {
    runtimeUserDataDir = message.runtime.userDataDir
    setUserDataDir(runtimeUserDataDir)
    send({ type: 'ready', protocolVersion: SUMMARY_WORKER_PROTOCOL_VERSION })
    return
  }
  if (message.type === 'cancel') {
    const job = running.get(message.jobId)
    if (job) {
      job.cancelled = true
      job.controller.abort()
    }
    return
  }
  if (message.type === 'shutdown') {
    setSummaryProgressSink(null)
    process.exit(0)
    return
  }
  if (message.type !== 'start') return

  void execute(message.job).then(
    (result) => send({ type: 'completed', protocolVersion: SUMMARY_WORKER_PROTOCOL_VERSION, jobId: message.job.jobId, key: message.job.key, result }),
    (error) => {
      if (isCancellationError(error)) {
        send({ type: 'cancelled', protocolVersion: SUMMARY_WORKER_PROTOCOL_VERSION, jobId: message.job.jobId, key: message.job.key })
        return
      }
      send({ type: 'failed', protocolVersion: SUMMARY_WORKER_PROTOCOL_VERSION, jobId: message.job.jobId, key: message.job.key, error: errorPayload(error) })
    }
  )
})
