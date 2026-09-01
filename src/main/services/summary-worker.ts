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

async function execute(job: SummaryWorkerJob): Promise<SummaryWorkerResult> {
  setConfigCache(job.config)
  setRuntimeApiSettings(job.settings)
  const controller = new AbortController()
  running.set(job.jobId, { key: job.key, controller, cancelled: false })
  send({
    type: 'progress',
    protocolVersion: SUMMARY_WORKER_PROTOCOL_VERSION,
    progress: { jobId: job.jobId, key: job.key, phase: phaseForTask(job), completed: 0, total: 1 }
  })
  try {
    switch (job.task.kind) {
      case 'ensure-doc':
        return await ensureDocSummary(job.task.projectId, job.task.docId, job.task.currentContent)
      case 'regenerate-doc':
        return await regenerateDocSummary(job.task.docId, job.task.forceFull ?? false)
      case 'queue-chat':
        await queueChatSummary(job.task.chatId, job.task.force ?? false)
        return undefined
      case 'regenerate-chat':
        return await regenerateChatSummary(job.task.chatId)
      case 'distill-resource':
        return await distillResource(job.task.projectId, job.task.resourceId, job.task.type, job.task.force ?? false)
      case 'generate-rollups':
        return await generateDocRollups(job.task.projectId, job.key)
      case 'regenerate-rollup':
        return await regenerateDocRollup(job.task.projectId, job.task.rollupId, job.key)
      case 'retry-pending':
        await retryPendingSummaries()
        return undefined
    }
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
    (error) => send({ type: 'failed', protocolVersion: SUMMARY_WORKER_PROTOCOL_VERSION, jobId: message.job.jobId, key: message.job.key, error: errorPayload(error) })
  )
})
