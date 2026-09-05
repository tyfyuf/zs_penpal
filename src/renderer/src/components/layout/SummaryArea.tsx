import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Eye, FlaskConical, RefreshCcw, RefreshCw, Trash2 } from 'lucide-react'
import type { ChatSummary, ConsistencyIssue, DocSummary, ProjectSummariesOverview, ResourceDistillType, ResourceSummary } from '@shared/types'
import type { SummaryProgress, SummaryQueueStatus } from '@shared/summary-job-protocol'
import { chatText, resourceText, storyText } from '../../lib/summaryPreview'
import { api } from '../../lib/api'
import { toast } from '../../store/toast.store'
import { confirmDialog } from '../../store/dialog.store'
import { useAppStore } from '../../store/app.store'
import { useT } from '../../i18n'
import { runDistill, runUndistill } from '../../lib/summaryActions'
import Modal from '../common/Modal'

type SummarySectionKey = 'docs' | 'chats' | 'resources'
type SummarySectionState = Record<SummarySectionKey, boolean>

const SUMMARY_SECTION_STORAGE_PREFIX = 'vibewrite.summary.sections:'
const CONSISTENCY_STORAGE_PREFIX = 'vibewrite.summary.consistency:'

function readSummarySectionState(projectId: string): SummarySectionState {
  const defaults: SummarySectionState = { docs: true, chats: true, resources: true }
  try {
    const raw = localStorage.getItem(`${SUMMARY_SECTION_STORAGE_PREFIX}${projectId}`)
    if (!raw) return defaults
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaults
    const values = parsed as Record<string, unknown>
    return {
      docs: typeof values.docs === 'boolean' ? values.docs : defaults.docs,
      chats: typeof values.chats === 'boolean' ? values.chats : defaults.chats,
      resources: typeof values.resources === 'boolean' ? values.resources : defaults.resources
    }
  } catch {
    return defaults
  }
}

type SummaryTranslator = (key: string, vars?: Record<string, string | number>) => string

function isTerminalProgress(progress: SummaryProgress | undefined): boolean {
  return progress?.phase === 'complete' || progress?.phase === 'failed' || progress?.phase === 'waiting-confirmation' || progress?.phase === 'cancelled'
}

function progressPercent(progress: SummaryProgress): number | null {
  if (progress.total <= 0) return null
  return Math.max(0, Math.min(100, Math.round((Math.min(progress.completed, progress.total) / progress.total) * 100)))
}

function ProgressBar({ progress, color = 'var(--warn)' }: { progress: SummaryProgress; color?: string }): JSX.Element {
  const percent = progressPercent(progress)
  return (
    <div className="mt-1 h-1 overflow-hidden rounded" style={{ background: 'var(--border)' }}>
      {percent === null ? (
        <div className="h-full w-2/5 animate-pulse rounded" style={{ background: color }} />
      ) : (
        <div className="h-full transition-all" style={{ width: `${percent}%`, background: color }} />
      )}
    </div>
  )
}

function ProgressText({ progress, t }: { progress: SummaryProgress; t: SummaryTranslator }): JSX.Element {
  const label = t(`summary.progress.${progress.phase}`)
  const percent = progressPercent(progress)
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate">{label}</span>
        {percent !== null && <span className="shrink-0">{Math.min(progress.completed, progress.total)}/{progress.total}</span>}
      </div>
      <ProgressBar progress={progress} color={progress.phase === 'complete' ? 'var(--ok)' : progress.phase === 'failed' ? 'var(--danger)' : progress.phase === 'cancelled' ? 'var(--muted)' : 'var(--warn)'} />
      {progress.detail && <div className="mt-1 truncate" title={progress.detail}>{progress.detail}</div>}
    </>
  )
}

function MiniProgress({ progress, t }: { progress?: SummaryProgress; t: SummaryTranslator }): JSX.Element | null {
  if (!progress || progress.phase === 'complete') return null
  return (
    <div className="mt-0.5 max-w-full text-[10px]" style={{ color: progress.phase === 'failed' ? 'var(--danger)' : progress.phase === 'cancelled' ? 'var(--muted)' : 'var(--warn)' }}>
      <ProgressText progress={progress} t={t} />
    </div>
  )
}

export default function SummaryArea({ projectId }: { projectId: string }): JSX.Element {
  const t = useT()
  const [overview, setOverview] = useState<ProjectSummariesOverview | null>(null)
  const [preview, setPreview] = useState<{ title: string; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [issues, setIssues] = useState<ConsistencyIssue[]>([])
  const [progressByJobId, setProgressByJobId] = useState<Record<string, SummaryProgress>>({})
  const [queueStatus, setQueueStatus] = useState<SummaryQueueStatus | null>(null)
  const [sectionOpen, setSectionOpen] = useState<SummarySectionState>(() => readSummarySectionState(projectId))
  const [consistencyOpen, setConsistencyOpen] = useState(() => {
    try {
      return localStorage.getItem(`${CONSISTENCY_STORAGE_PREFIX}${projectId}`) !== 'false'
    } catch {
      return true
    }
  })
  const summaryRevision = useAppStore((s) => s.summaryRevision)

  useEffect(() => {
    try {
      localStorage.setItem(`${SUMMARY_SECTION_STORAGE_PREFIX}${projectId}`, JSON.stringify(sectionOpen))
    } catch {
      // Ignore storage failures; section toggles remain functional for this session.
    }
  }, [projectId, sectionOpen])

  useEffect(() => {
    try {
      localStorage.setItem(`${CONSISTENCY_STORAGE_PREFIX}${projectId}`, String(consistencyOpen))
    } catch {
      // Ignore storage failures; the toggle remains functional for this session.
    }
  }, [projectId, consistencyOpen])

  useEffect(() => {
    setSectionOpen(readSummarySectionState(projectId))
    try {
      setConsistencyOpen(localStorage.getItem(`${CONSISTENCY_STORAGE_PREFIX}${projectId}`) !== 'false')
    } catch {
      setConsistencyOpen(true)
    }
  }, [projectId])

  const toggleSection = (key: SummarySectionKey): void => {
    setSectionOpen((current) => ({ ...current, [key]: !current[key] }))
  }

  const load = useCallback(async (): Promise<void> => {
    try {
      setOverview(await api.invoke('summary:listProject', projectId))
      setIssues(await api.invoke('summary:scanConsistency', projectId))
    } catch (err) {
      toast.error((err as Error).message)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load, summaryRevision])

  useEffect(() => {
    setProgressByJobId({})
  }, [projectId])

  useEffect(() => {
    const off = api.on('summary:queue', (next) => {
      setQueueStatus(next)
    })
    return off
  }, [])

  // Summary status events refresh the list and unlock completed items.
  useEffect(() => {
    const off = api.on('summary:status', () => {
      void load()
    })
    return off
  }, [load])

  useEffect(() => {
    const off = api.on('summary:progress', (next) => {
      setProgressByJobId((current) => ({ ...current, [next.jobId]: next }))
      if (isTerminalProgress(next)) {
        const delay = next.phase === 'failed' ? 5000 : next.phase === 'cancelled' ? 2500 : 1500
        window.setTimeout(() => {
          setProgressByJobId((current) => {
            if (current[next.jobId]?.key !== next.key) return current
            const { [next.jobId]: _removed, ...rest } = current
            return rest
          })
        }, delay)
        void load()
      }
    })
    return off
  }, [load])

  async function previewDoc(docId: string): Promise<void> {
    try {
      const s = await api.invoke('summary:getDoc', docId)
      if (s) setPreview({ title: t('summary.previewDocTitle'), text: storyText(s) })
      else toast.info(t('summary.noDocSummary'))
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function previewChat(chatId: string): Promise<void> {
    try {
      const s = await api.invoke('summary:getChat', chatId)
      if (s) setPreview({ title: t('summary.previewChatTitle'), text: chatText(s) })
      else toast.info(t('summary.noChatSummary'))
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function previewResource(resourceId: string): Promise<void> {
    try {
      const s = await api.invoke('summary:getResource', { projectId, resourceId })
      if (s) setPreview({ title: t('summary.previewResTitle'), text: resourceText(s) })
      else toast.info(t('summary.noResSummary'))
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function regenDoc(docId: string, forceFull = false): Promise<void> {
    if (forceFull && !(await confirmDialog(t('summary.confirmFullRegenerate')))) return
    setBusy(true)
    try {
      const res = await api.invoke('summary:regenerateDoc', { docId, forceFull })
      if (res.ok) {
        toast.success(t('summary.docRegenerated'))
        useAppStore.getState().bumpSummary()
        await load()
      } else {
        toast.error(res.error ?? t('summary.regenerateFail'))
      }
    } finally {
      setBusy(false)
    }
  }

  async function regenChat(chatId: string): Promise<void> {
    setBusy(true)
    try {
      const res = await api.invoke('summary:regenerateChat', chatId)
      if (res.ok) {
        toast.success(t('summary.chatRegenerated'))
        // Refresh after the background chat queue has had time to finish.
        setTimeout(() => {
          useAppStore.getState().bumpSummary()
          void load()
        }, 2500)
      } else {
        toast.error(res.error ?? t('summary.regenerateFail'))
      }
    } finally {
      setBusy(false)
    }
  }

  async function regenResource(resourceId: string, type: ResourceDistillType): Promise<void> {
    setBusy(true)
    try {
      const res = await api.invoke('resource:distill', { projectId, resourceId, type, force: true })
      if (res.ok) {
        if (res.summary?.generation.state === 'incomplete') toast.error(t('summary.incomplete'))
        else toast.success(t('distill.ok'))
        useAppStore.getState().bumpSummary()
        await load()
      } else toast.error(res.error ?? t('distill.fail'))
    } finally {
      setBusy(false)
    }
  }

  if (!overview) {
    return <div className="px-6 py-2 text-xs" style={{ color: 'var(--muted)' }}>{t('summary.loading')}</div>
  }

  const visibleKeys = new Set<string>([
    ...overview.docs.map((d) => `doc:${d.docId}`),
    ...overview.chats.map((c) => `chat:${c.chatId}`),
    ...overview.resources.map((r) => `res:${r.resourceId}`)
  ])
  for (const progress of Object.values(progressByJobId)) {
    if (progress.key.startsWith(`rollup:${projectId}`)) visibleKeys.add(progress.key)
  }
  const visibleProgress = Object.values(progressByJobId).filter((progress) => visibleKeys.has(progress.key) && progress.key !== 'chat:retry-pending')
  const activeProgress = visibleProgress.filter((progress) => !isTerminalProgress(progress))
  const runningTaskCount = queueStatus?.total ?? activeProgress.length
  const progressTitle = (key: string): string => {
    const [kind, id] = key.split(':', 2)
    if (kind === 'doc') return overview.docs.find((item) => item.docId === id)?.title ?? t('summary.docTask')
    if (kind === 'chat') return overview.chats.find((item) => item.chatId === id)?.title ?? t('summary.chatTask')
    if (kind === 'res') return overview.resources.find((item) => item.resourceId === id)?.name ?? t('summary.resourceTask')
    return t('summary.rollupTask')
  }
  const progressByKeyObject = Object.fromEntries(visibleProgress.map((progress) => [progress.key, progress])) as Record<string, SummaryProgress>
  const distilledResources = overview.resources.filter((resource) => {
    const progress = progressByKeyObject[`res:${resource.resourceId}`]
    return resource.distilled || resource.generating || progress?.phase === 'failed' || progress?.phase === 'cancelled'
  })

  return (
    <div className="space-y-2 px-4 pb-2">
      {(visibleProgress.length > 0 || runningTaskCount > 0) && (
        <div className="rounded border px-2 py-1.5 text-[11px]" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
          <div className="mb-1 font-medium" style={{ color: 'var(--text)' }}>
            {runningTaskCount > 0 ? t('summary.progress.tasksRunning', { count: runningTaskCount }) : t('summary.progress.tasksRecent')}
          </div>
          <div className="space-y-2">
            {visibleProgress.map((progress) => (
              <div key={progress.jobId}>
                <div className="mb-0.5 truncate" title={progressTitle(progress.key)}>{progressTitle(progress.key)}</div>
                <ProgressText progress={progress} t={t} />
              </div>
            ))}
          </div>
        </div>
      )}

      {issues.length > 0 && (
        <SummarySection
          label={t('summary.secConsistency')}
          open={consistencyOpen}
          onToggle={() => setConsistencyOpen((open) => !open)}
          ariaLabel={t(consistencyOpen ? 'summary.collapseSection' : 'summary.expandSection', { section: t('summary.secConsistency') })}
        >
          {issues.map((iss, idx) => (
            <div key={idx} className="flex items-start gap-1 text-[11px]" style={{ color: iss.severity === 'error' ? 'var(--danger)' : 'var(--warn)' }}>
              <span>{iss.severity === 'error' ? '?' : '!'}</span>
              <span className="min-w-0 flex-1 break-words">{iss.message}</span>
            </div>
          ))}
        </SummarySection>
      )}

      <SummarySection
        label={t('summary.secDocs')}
        open={sectionOpen.docs}
        onToggle={() => toggleSection('docs')}
        ariaLabel={t(sectionOpen.docs ? 'summary.collapseSection' : 'summary.expandSection', { section: t('summary.secDocs') })}
      >
        {overview.docs.length === 0 && <div className="text-[11px]" style={{ color: 'var(--muted)' }}>{t('summary.noDocs')}</div>}
        {overview.docs.map((d) => {
          const progress = progressByKeyObject[`doc:${d.docId}`]
          const failed = progress?.phase === 'failed'
          const statusText = d.status === 'empty'
            ? t('summary.docStatusEmpty')
            : d.status === 'short'
              ? t('summary.docStatusShort')
              : d.status === 'missing'
                ? t('summary.docStatusMissing')
                : d.status === 'stale'
                  ? t('summary.docStatusStale')
                  : d.status === 'incomplete'
                    ? t('summary.docStatusIncomplete', { completed: d.completedChunks ?? 0, total: d.totalChunks ?? 0 })
                    : ''
          const warn = d.status === 'stale' || d.status === 'incomplete'
          return (
            <div key={d.docId} className="flex items-start gap-1 text-[12px]">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: d.generating ? 'var(--warn)' : failed ? 'var(--danger)' : warn ? 'var(--warn)' : d.status === 'fresh' ? 'var(--ok)' : d.status === 'short' ? 'var(--accent)' : 'var(--border)' }} />
              <span className="min-w-0 flex-1" title={d.title}>
                <span className="block truncate">{d.title}</span>
                {d.generating && <span className="text-[10px]" style={{ color: 'var(--warn)' }}>{t('summary.generating')}</span>}
                {!d.generating && failed && <span className="text-[10px]" style={{ color: 'var(--danger)' }}>{t('summary.progress.failed')}</span>}
                {!d.generating && !failed && statusText && <span className="text-[10px]" style={{ color: warn ? 'var(--warn)' : 'var(--muted)' }}>{statusText}</span>}
                <MiniProgress progress={progress} t={t} />
              </span>
              {!d.generating && d.hasSummary && <IconBtn icon={<Eye size={12} />} title={t('summary.preview')} onClick={() => void previewDoc(d.docId)} />}
              {!d.generating && d.status !== 'empty' && d.status !== 'short' && <IconBtn icon={<RefreshCw size={12} />} title={t('summary.regenerate')} disabled={busy} onClick={() => void regenDoc(d.docId)} />}
              {!d.generating && d.hasSummary && <IconBtn icon={<RefreshCcw size={12} />} title={t('summary.fullRegenerate')} disabled={busy} onClick={() => void regenDoc(d.docId, true)} />}
            </div>
          )
        })}
      </SummarySection>

      <SummarySection
        label={t('summary.secChats')}
        open={sectionOpen.chats}
        onToggle={() => toggleSection('chats')}
        ariaLabel={t(sectionOpen.chats ? 'summary.collapseSection' : 'summary.expandSection', { section: t('summary.secChats') })}
      >
        {overview.chats.length === 0 && <div className="text-[11px]" style={{ color: 'var(--muted)' }}>{t('summary.noChats')}</div>}
        {overview.chats.map((c) => {
          const progress = progressByKeyObject[`chat:${c.chatId}`]
          const failed = progress?.phase === 'failed'
          return (
            <div key={c.chatId} className="flex items-start gap-1 text-[12px]">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: c.generating ? 'var(--warn)' : failed ? 'var(--danger)' : c.hasSummary ? 'var(--ok)' : 'var(--border)' }} />
              <span className="min-w-0 flex-1" title={c.title}>
                <span className="block truncate">{c.title}</span>
                {c.generating && <span className="text-[10px]" style={{ color: 'var(--warn)' }}>{t('summary.generating')}</span>}
                {!c.generating && failed && <span className="text-[10px]" style={{ color: 'var(--danger)' }}>{t('summary.progress.failed')}</span>}
                <MiniProgress progress={progress} t={t} />
              </span>
              {!c.generating && c.hasSummary && <IconBtn icon={<Eye size={12} />} title={t('summary.preview')} onClick={() => void previewChat(c.chatId)} />}
              {!c.generating && <IconBtn icon={<RefreshCw size={12} />} title={t('summary.regenerate')} disabled={busy} onClick={() => void regenChat(c.chatId)} />}
            </div>
          )
        })}
      </SummarySection>

      <SummarySection
        label={t('summary.secResources')}
        open={sectionOpen.resources}
        onToggle={() => toggleSection('resources')}
        ariaLabel={t(sectionOpen.resources ? 'summary.collapseSection' : 'summary.expandSection', { section: t('summary.secResources') })}
      >
        {distilledResources.length === 0 && <div className="text-[11px]" style={{ color: 'var(--muted)' }}>{t('summary.noResources')}</div>}
        {distilledResources.map((r) => {
          const progress = progressByKeyObject[`res:${r.resourceId}`]
          const generating = r.generating || (!!progress && !isTerminalProgress(progress))
          const failed = progress?.phase === 'failed'
          return (
            <div key={r.resourceId} className="flex items-start gap-1 text-[12px]">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: generating ? 'var(--warn)' : failed ? 'var(--danger)' : r.stale || r.incomplete ? 'var(--warn)' : 'var(--ok)' }} />
              <span className="min-w-0 flex-1" title={r.name}>
                <span className="block truncate">{r.name}</span>
                {generating ? (
                  <span className="text-[10px]" style={{ color: 'var(--warn)' }}>{t('summary.generating')}</span>
                ) : failed ? (
                  <span className="text-[10px]" style={{ color: 'var(--danger)' }}>{t('summary.progress.failed')}</span>
                ) : (
                  <span className="text-[10px]" style={{ color: 'var(--muted)' }}>
                    ({r.type === 'story' ? t('summary.typeStory') : r.type === 'setting' ? t('summary.typeSetting') : t('summary.typeOther')})
                    {r.stale && ` · ${t('summary.stale')}`}
                    {r.incomplete && ` · ${t('summary.incomplete')}`}
                  </span>
                )}
                <MiniProgress progress={progress} t={t} />
              </span>
              {!generating && <IconBtn icon={<Eye size={12} />} title={t('summary.preview')} onClick={() => void previewResource(r.resourceId)} />}
              {!generating && r.type && <IconBtn icon={<RefreshCw size={12} />} title={t('summary.retryDistill')} disabled={busy} onClick={() => void regenResource(r.resourceId, r.type!)} />}
              {!generating && (
                <IconBtn icon={<Trash2 size={12} />} title={t('summary.undistill')} onClick={() => void runUndistill(projectId, r.resourceId).then(load)} />
              )}
            </div>
          )
        })}
        {overview.resources.some((r) => !r.distilled && !r.generating) && (
          <div className="text-[10px]" style={{ color: 'var(--muted)' }}>
            {t('summary.distillHint')}
          </div>
        )}
      </SummarySection>

      {preview && (
        <Modal title={preview.title} onClose={() => setPreview(null)} footer={<button className="btn" onClick={() => setPreview(null)}>{t('dialog.cancel')}</button>}>
          <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed">{preview.text}</pre>
        </Modal>
      )}
    </div>
  )
}

function SummarySection({
  label,
  open,
  onToggle,
  ariaLabel,
  children
}: {
  label: string
  open: boolean
  onToggle: () => void
  ariaLabel: string
  children: ReactNode
}): JSX.Element {
  return (
    <section className="mt-2">
      <button
        type="button"
        className="group flex w-full items-center gap-1 text-left text-[11px] font-medium hover:opacity-80"
        style={{ color: 'var(--muted)' }}
        aria-expanded={open}
        aria-label={ariaLabel}
        title={ariaLabel}
        onClick={onToggle}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{label}</span>
      </button>
      {open && <div className="mt-1 space-y-1">{children}</div>}
    </section>
  )
}

function IconBtn({ icon, title, disabled, onClick }: { icon: JSX.Element; title: string; disabled?: boolean; onClick: () => void }): JSX.Element {
  return (
    <button
      className="rounded p-0.5 hover:opacity-70 disabled:opacity-40"
      style={{ color: 'var(--muted)' }}
      title={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      {icon}
    </button>
  )
}
