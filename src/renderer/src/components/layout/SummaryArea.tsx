import { useCallback, useEffect, useState } from 'react'
import { Eye, FlaskConical, RefreshCw, Trash2 } from 'lucide-react'
import type { ChatSummary, DocSummary, ProjectSummariesOverview, ResourceSummary } from '@shared/types'
import { api } from '../../lib/api'
import { toast } from '../../store/toast.store'
import { useAppStore } from '../../store/app.store'
import { useT } from '../../i18n'
import { runDistill, runUndistill } from '../../lib/summaryActions'
import Modal from '../common/Modal'

function storyText(s: {
  overview: string
  characters: { name: string; aliases: string[]; role: string; goal: string }[]
  plot: { id: string; function: string; summary: string }[]
  foreshadowing: { planted: string; status: string }[]
  keySettings: string[]
  keyQuotes: string[]
}): string {
  const chars = (Array.isArray(s.characters) ? s.characters : [])
    .map((c) => `- ${c.name}${c.aliases?.length ? `（${c.aliases.join('、')}）` : ''}：${c.role}${c.goal ? ` · 目标：${c.goal}` : ''}`)
    .join('\n')
  const plot = (Array.isArray(s.plot) ? s.plot : []).map((p) => `- ${p.id}｜${p.function}：${p.summary}`).join('\n')
  const fs = (Array.isArray(s.foreshadowing) ? s.foreshadowing : []).map((f) => `- ${f.planted}（${f.status === 'resolved' ? '已回收' : '未回收'}）`).join('\n')
  const settings = Array.isArray(s.keySettings) ? s.keySettings : []
  const quotes = Array.isArray(s.keyQuotes) ? s.keyQuotes : []
  return `总览：${s.overview || '（无）'}\n\n人物：\n${chars || '（无）'}\n\n情节链：\n${plot || '（无）'}\n\n伏笔：\n${fs || '（无）'}\n\n关键设定：${settings.join('、') || '（无）'}\n关键台词：${quotes.join(' / ') || '（无）'}`
}

function chatText(s: ChatSummary): string {
  return (Array.isArray(s.items) ? s.items : []).map((i) => `${i.role === 'user' ? '用户' : 'AI'}：${i.summary}`).join('\n') || '（无）'
}

function resourceText(s: ResourceSummary): string {
  if (s.type === 'story') return storyText(s)
  const keyPoints = Array.isArray(s.keyPoints) ? s.keyPoints : []
  const keyTerms = Array.isArray(s.keyTerms) ? s.keyTerms : []
  return `类型：${s.docType || '未知'}\n概述：${s.overview || '（无）'}\n要点：\n${keyPoints.map((p) => `- ${p}`).join('\n') || '（无）'}\n术语：${keyTerms.join('、') || '（无）'}\n结构：${s.structure || '（无）'}`
}

export default function SummaryArea({ projectId }: { projectId: string }): JSX.Element {
  const t = useT()
  const [overview, setOverview] = useState<ProjectSummariesOverview | null>(null)
  const [preview, setPreview] = useState<{ title: string; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const summaryRevision = useAppStore((s) => s.summaryRevision)

  const load = useCallback(async (): Promise<void> => {
    try {
      setOverview(await api.invoke('summary:listProject', projectId))
    } catch (err) {
      toast.error((err as Error).message)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load, summaryRevision])

  // 摘要生成状态事件：开始/结束都刷新，展示黄点“生成中”→绿点解锁
  useEffect(() => {
    const off = api.on('summary:status', () => {
      void load()
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

  async function regenDoc(docId: string): Promise<void> {
    setBusy(true)
    try {
      const res = await api.invoke('summary:regenerateDoc', docId)
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
        // 等待后台队列完成后刷新
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

  if (!overview) {
    return <div className="px-6 py-2 text-xs" style={{ color: 'var(--muted)' }}>{t('summary.loading')}</div>
  }

  const distilledResources = overview.resources.filter((r) => r.distilled || r.generating)

  return (
    <div className="space-y-2 px-4 pb-2">
      <div className="text-[11px] font-medium" style={{ color: 'var(--muted)' }}>{t('summary.secDocs')}</div>
      {overview.docs.length === 0 && <div className="text-[11px]" style={{ color: 'var(--muted)' }}>{t('summary.noDocs')}</div>}
      {overview.docs.map((d) => (
        <div key={d.docId} className="flex items-center gap-1 text-[12px]">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: d.generating ? 'var(--warn)' : d.hasSummary ? 'var(--ok)' : 'var(--border)' }}
          />
          <span className="min-w-0 flex-1 truncate" title={d.title}>
            {d.title}
            {d.generating && <span className="text-[10px]" style={{ color: 'var(--warn)' }}> · {t('summary.generating')}</span>}
          </span>
          {!d.generating && d.hasSummary && <IconBtn icon={<Eye size={12} />} title={t('summary.preview')} onClick={() => void previewDoc(d.docId)} />}
          {!d.generating && <IconBtn icon={<RefreshCw size={12} />} title={t('summary.regenerate')} disabled={busy} onClick={() => void regenDoc(d.docId)} />}
        </div>
      ))}

      <div className="mt-2 text-[11px] font-medium" style={{ color: 'var(--muted)' }}>{t('summary.secChats')}</div>
      {overview.chats.length === 0 && <div className="text-[11px]" style={{ color: 'var(--muted)' }}>{t('summary.noChats')}</div>}
      {overview.chats.map((c) => (
        <div key={c.chatId} className="flex items-center gap-1 text-[12px]">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: c.generating ? 'var(--warn)' : c.hasSummary ? 'var(--ok)' : 'var(--border)' }}
          />
          <span className="min-w-0 flex-1 truncate" title={c.title}>
            {c.title}
            {c.generating && <span className="text-[10px]" style={{ color: 'var(--warn)' }}> · {t('summary.generating')}</span>}
          </span>
          {!c.generating && c.hasSummary && <IconBtn icon={<Eye size={12} />} title={t('summary.preview')} onClick={() => void previewChat(c.chatId)} />}
          {!c.generating && <IconBtn icon={<RefreshCw size={12} />} title={t('summary.regenerate')} disabled={busy} onClick={() => void regenChat(c.chatId)} />}
        </div>
      ))}

      <div className="mt-2 text-[11px] font-medium" style={{ color: 'var(--muted)' }}>{t('summary.secResources')}</div>
      {distilledResources.length === 0 && <div className="text-[11px]" style={{ color: 'var(--muted)' }}>{t('summary.noResources')}</div>}
      {distilledResources.map((r) => (
        <div key={r.resourceId} className="flex items-center gap-1 text-[12px]">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: r.generating ? 'var(--warn)' : 'var(--ok)' }}
          />
          <span className="min-w-0 flex-1 truncate" title={r.name}>
            {r.name}
            {r.generating ? (
              <span className="text-[10px]" style={{ color: 'var(--warn)' }}> · {t('summary.generating')}</span>
            ) : (
              <span className="text-[10px]" style={{ color: 'var(--muted)' }}>
                （{r.type === 'story' ? t('summary.typeStory') : t('summary.typeOther')}）
              </span>
            )}
          </span>
          {!r.generating && <IconBtn icon={<Eye size={12} />} title={t('summary.preview')} onClick={() => void previewResource(r.resourceId)} />}
          {!r.generating && (
            <IconBtn icon={<Trash2 size={12} />} title={t('summary.undistill')} onClick={() => void runUndistill(projectId, r.resourceId).then(load)} />
          )}
        </div>
      ))}
      {overview.resources.some((r) => !r.distilled && !r.generating) && (
        <div className="text-[10px]" style={{ color: 'var(--muted)' }}>
          {t('summary.distillHint')}
        </div>
      )}

      {preview && (
        <Modal title={preview.title} onClose={() => setPreview(null)} footer={<button className="btn" onClick={() => setPreview(null)}>{t('dialog.cancel')}</button>}>
          <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed">{preview.text}</pre>
        </Modal>
      )}
    </div>
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
