import type { DocSummary } from '@shared/types'
import type { SummaryReadinessProgress } from '@shared/summary-job-protocol'
import { isShortDocForSummary, isSourceStale, nonWhitespaceLength } from '../summary-source'
import { analyzeTextIntegrity } from './text-decoding.service'
import { buildSnapshot, listProjects, readDoc, readDocSummary } from './file.service'
import { ensureDocSummaryInWorker, generateDocRollupsInWorker } from './summary-job-manager'
import { projectDocRollupsNeedMaintenance } from './summary.service'
import { loadConfig } from './config.service'
import { logError } from './log.service'
import { isFeatureGuideProject } from './file.service'

export const DOC_SUMMARY_IDLE_DELAY_MS = 15 * 60 * 1000
const RETRY_DELAYS_MS = [30_000, 3 * 60_000] as const

const timers = new Map<string, NodeJS.Timeout>()
const retryAttempts = new Map<string, number>()
let maintenanceQueue: Promise<void> = Promise.resolve()
let shuttingDown = false

function timerKey(projectId: string, docId: string): string {
  return `${projectId}:${docId}`
}

function rollupTimerKey(projectId: string): string {
  return `rollup:${projectId}`
}

async function projectAutoMaintenanceEnabled(projectId: string): Promise<boolean> {
  const project = (await listProjects()).find((item) => item.id === projectId)
  return project?.status === 'normal' && project.summaryAutoMaintenance === true
}

function clearTimer(key: string): void {
  const timer = timers.get(key)
  if (timer) clearTimeout(timer)
  timers.delete(key)
}

function setMaintenanceTimer(key: string, delayMs: number, task: () => Promise<void>): void {
  clearTimer(key)
  const timer = setTimeout(() => {
    if (timers.get(key) !== timer) return
    timers.delete(key)
    enqueueMaintenance(task)
  }, Math.max(0, delayMs))
  timer.unref()
  timers.set(key, timer)
}

function enqueueMaintenance(task: () => Promise<void>): void {
  if (shuttingDown) return
  const run = async (): Promise<void> => {
    if (shuttingDown) return
    await task()
  }
  maintenanceQueue = maintenanceQueue.then(run, run).catch((error) => {
    logError('summary:maintenance', 'Document summary maintenance task failed', error instanceof Error ? error.stack : String(error))
  })
}

async function currentSummary(projectId: string, docId: string): Promise<{ content: string; updatedAt: string; summary: DocSummary | null } | null> {
  try {
    const [{ content, doc }, summary] = await Promise.all([readDoc(docId), readDocSummary(projectId, docId)])
    if (analyzeTextIntegrity(content).suspicious) return null
    return { content, updatedAt: doc.updatedAt, summary }
  } catch {
    return null
  }
}

function needsMaintenance(content: string, summary: DocSummary | null): boolean {
  if (nonWhitespaceLength(content) === 0 || isShortDocForSummary(content)) return false
  return !summary || summary.generation.state === 'incomplete' || isSourceStale(summary, content)
}

function idleDelayRemaining(updatedAt: string, now = Date.now()): number {
  const savedAt = Date.parse(updatedAt)
  if (!Number.isFinite(savedAt)) return 0
  return Math.max(0, DOC_SUMMARY_IDLE_DELAY_MS - Math.max(0, now - savedAt))
}

async function runMaintenance(projectId: string, docId: string, retry = false): Promise<void> {
  const key = timerKey(projectId, docId)
  if (shuttingDown || !(await projectAutoMaintenanceEnabled(projectId))) {
    retryAttempts.delete(key)
    return
  }
  const state = await currentSummary(projectId, docId)
  if (!state || !needsMaintenance(state.content, state.summary)) {
    retryAttempts.delete(key)
    await scheduleProjectRollupMaintenance(projectId, 0)
    return
  }
  const remainingIdleDelay = idleDelayRemaining(state.updatedAt)
  if (remainingIdleDelay > 0) {
    if (!timers.has(key)) await scheduleDocSummaryMaintenance(projectId, docId, remainingIdleDelay)
    return
  }

  try {
    await ensureDocSummaryInWorker(projectId, docId, state.content)
  } catch (error) {
    logError('summary:maintenance', `Document summary generation failed docId=${docId}`, error instanceof Error ? error.stack : String(error))
  }
  const latest = await currentSummary(projectId, docId)
  if (!latest || !needsMaintenance(latest.content, latest.summary)) {
    retryAttempts.delete(key)
    await scheduleProjectRollupMaintenance(projectId, 0)
    return
  }
  const latestIdleDelay = idleDelayRemaining(latest.updatedAt)
  if (latestIdleDelay > 0) {
    if (!timers.has(key)) await scheduleDocSummaryMaintenance(projectId, docId, latestIdleDelay)
    return
  }

  const attempt = retry ? (retryAttempts.get(key) ?? 0) + 1 : 0
  retryAttempts.set(key, attempt)
  const delay = RETRY_DELAYS_MS[attempt]
  if (delay === undefined) return
  setMaintenanceTimer(key, delay, () => runMaintenance(projectId, docId, true))
}

async function runRollupMaintenance(projectId: string, retry = false): Promise<void> {
  const key = rollupTimerKey(projectId)
  if (shuttingDown || !(await projectAutoMaintenanceEnabled(projectId))) {
    retryAttempts.delete(key)
    return
  }
  if (!(await projectDocRollupsNeedMaintenance(projectId))) {
    retryAttempts.delete(key)
    return
  }

  let result: { ok: boolean; error?: string }
  try {
    result = await generateDocRollupsInWorker(projectId)
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (result.ok || !(await projectDocRollupsNeedMaintenance(projectId))) {
    retryAttempts.delete(key)
    return
  }

  logError('summary:maintenance', `Document rollup maintenance failed projectId=${projectId}`, result.error ?? 'Unknown rollup error')
  const attempt = retry ? (retryAttempts.get(key) ?? 0) + 1 : 0
  retryAttempts.set(key, attempt)
  const delay = RETRY_DELAYS_MS[attempt]
  if (delay === undefined) return
  setMaintenanceTimer(key, delay, () => runRollupMaintenance(projectId, true))
}

export async function scheduleProjectRollupMaintenance(
  projectId: string,
  delayMs = DOC_SUMMARY_IDLE_DELAY_MS
): Promise<void> {
  if (!(await projectAutoMaintenanceEnabled(projectId))) return
  const key = rollupTimerKey(projectId)
  clearTimer(key)
  retryAttempts.delete(key)
  setMaintenanceTimer(key, delayMs, () => runRollupMaintenance(projectId))
}

export async function scheduleDocSummaryMaintenance(
  projectId: string,
  docId: string,
  delayMs = DOC_SUMMARY_IDLE_DELAY_MS
): Promise<void> {
  if (!(await projectAutoMaintenanceEnabled(projectId))) return
  const key = timerKey(projectId, docId)
  clearTimer(key)
  retryAttempts.delete(key)
  setMaintenanceTimer(key, delayMs, () => runMaintenance(projectId, docId))
  await scheduleProjectRollupMaintenance(projectId, delayMs)
}

export async function scanProjectForDocSummaryMaintenance(projectId: string): Promise<void> {
  const cfg = await loadConfig()
  if (!cfg.summaryEnabled || !(await projectAutoMaintenanceEnabled(projectId))) return
  const tree = (await buildSnapshot()).projects.find((item) => item.project.id === projectId)
  const now = Date.now()
  let rollupDelay = 0
  for (const doc of tree?.docs ?? []) {
    const delay = idleDelayRemaining(doc.updatedAt, now)
    rollupDelay = Math.max(rollupDelay, delay)
    const state = await currentSummary(projectId, doc.id)
    if (!state || !needsMaintenance(state.content, state.summary)) continue
    await scheduleDocSummaryMaintenance(projectId, doc.id, delay)
  }
  await scheduleProjectRollupMaintenance(projectId, rollupDelay)
}

export function cancelDocSummaryMaintenance(projectId: string, docId: string): void {
  const key = timerKey(projectId, docId)
  clearTimer(key)
  retryAttempts.delete(key)
}

export function cancelProjectDocSummaryMaintenance(projectId: string): void {
  for (const key of [...timers.keys()]) {
    if (!key.startsWith(`${projectId}:`) && key !== rollupTimerKey(projectId)) continue
    clearTimer(key)
    retryAttempts.delete(key)
  }
}

export async function applyProjectDocSummaryMaintenance(projectId: string, enabled: boolean): Promise<void> {
  if (!enabled) {
    cancelProjectDocSummaryMaintenance(projectId)
    return
  }
  await scanProjectForDocSummaryMaintenance(projectId)
}

export async function initializeDocSummaryMaintenance(): Promise<void> {
  shuttingDown = false
  for (const key of [...timers.keys()]) clearTimer(key)
  retryAttempts.clear()

  const cfg = await loadConfig()
  if (!cfg.workspaceDir.trim() || !cfg.summaryEnabled) return

  const projects = await listProjects('normal')
  for (const project of projects) {
    if (project.summaryAutoMaintenance) await scanProjectForDocSummaryMaintenance(project.id)
  }
}

/**
 * Before a chat request, generate summaries that are completely missing.
 * Existing stale/incomplete summaries remain usable and are repaired in the background.
 */
export type SummaryReadinessUpdate = Omit<SummaryReadinessProgress, 'requestId' | 'chatId'>

export async function ensureProjectDocSummariesReady(
  projectId: string,
  onProgress?: (progress: SummaryReadinessUpdate) => void
): Promise<string[]> {
  const notify = (progress: SummaryReadinessUpdate): void => {
    try {
      onProgress?.(progress)
    } catch {
      // Progress reporting is best effort and must never affect summary generation.
    }
  }

  notify({ phase: 'checking', completed: 0, total: 0 })

  const cfg = await loadConfig()
  if (!cfg.summaryEnabled) {
    notify({ phase: 'ready', completed: 0, total: 0 })
    return []
  }
  const tree = (await buildSnapshot()).projects.find((item) => item.project.id === projectId)
  if (!tree) {
    notify({ phase: 'ready', completed: 0, total: 0 })
    return []
  }
  const autoMaintenance = tree.project.summaryAutoMaintenance === true

  const missing: { docId: string; title: string; content: string }[] = []
  for (const doc of tree.docs) {
    const state = await currentSummary(projectId, doc.id)
    if (!state) continue
    if (nonWhitespaceLength(state.content) === 0 || isShortDocForSummary(state.content)) continue
    if (!state.summary) {
      missing.push({ docId: doc.id, title: doc.title, content: state.content })
    } else if (autoMaintenance && (state.summary.generation.state === 'incomplete' || isSourceStale(state.summary, state.content))) {
      await scheduleDocSummaryMaintenance(projectId, doc.id, idleDelayRemaining(state.updatedAt))
    }
  }

  if (missing.length === 0) {
    if (autoMaintenance) await scheduleProjectRollupMaintenance(projectId, 0)
    notify({ phase: 'ready', completed: 0, total: 0 })
    return []
  }

  notify({ phase: 'generating', completed: 0, total: missing.length })
  let completed = 0
  const results = await Promise.all(missing.map(async (doc) => {
    try {
      await ensureDocSummaryInWorker(projectId, doc.docId, doc.content)
    } catch (error) {
      logError('summary:chat-readiness', `Document summary generation failed docId=${doc.docId}`, error instanceof Error ? error.stack : String(error))
    }
    const latest = await currentSummary(projectId, doc.docId)
    if (autoMaintenance && latest?.summary && needsMaintenance(latest.content, latest.summary)) {
      await scheduleDocSummaryMaintenance(projectId, doc.docId, idleDelayRemaining(latest.updatedAt))
    }
    completed += 1
    notify({
      phase: 'generating',
      completed,
      total: missing.length,
      currentTitle: doc.title,
      currentKey: `doc:${doc.docId}`
    })
    return { ...doc, summary: latest?.summary ?? null }
  }))

  const failed = results.filter((item) => !item.summary).map((item) => item.title)
  if (failed.length > 0) {
    notify({
      phase: 'failed',
      completed,
      total: missing.length,
      error: cfg.language === 'en'
        ? `Document summaries could not be generated for: ${failed.join(', ')}`
        : `以下文档摘要生成失败：${failed.map((name) => `《${name}》`).join('、')}。请检查摘要模型与 API 设置后重试。`
    })
  } else {
    if (autoMaintenance) await scheduleProjectRollupMaintenance(projectId, 0)
    notify({ phase: 'ready', completed, total: missing.length })
  }
  return failed
}

export function shutdownDocSummaryMaintenance(): void {
  shuttingDown = true
  for (const key of [...timers.keys()]) clearTimer(key)
  retryAttempts.clear()
}
