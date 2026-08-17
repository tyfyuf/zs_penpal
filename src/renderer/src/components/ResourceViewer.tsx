import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import type { TextEncodingInfo } from '@shared/types'
import type { Tab } from '../store/app.store'
import { useAppStore } from '../store/app.store'
import { api } from '../lib/api'
import { toast } from '../store/toast.store'
import { useT } from '../i18n'

const ALLOWED_EXT = ['.txt', '.md', '.csv']

export default function ResourceViewer({ tab }: { tab: Tab }): JSX.Element {
  const t = useT()
  const refreshWorkspace = useAppStore((state) => state.refreshWorkspace)
  const fileInput = useRef<HTMLInputElement>(null)
  const [content, setContent] = useState('')
  const [encoding, setEncoding] = useState<TextEncodingInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [repairing, setRepairing] = useState(false)

  async function load(): Promise<void> {
    if (!tab.refId || !tab.projectId) return
    const res = await api.invoke('resource:read', { projectId: tab.projectId, resourceId: tab.refId })
    setContent(res.content)
    setEncoding(res.encoding)
    setLoading(false)
  }

  useEffect(() => {
    setLoading(true)
    void load().catch((err) => {
      setLoading(false)
      toast.error((err as Error).message)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.refId, tab.projectId])

  async function reimport(file: File): Promise<void> {
    if (!tab.refId || !tab.projectId) return
    const ext = '.' + file.name.split('.').pop()?.toLowerCase()
    if (!ALLOWED_EXT.includes(ext)) {
      toast.error(t('sidebar.badExt'))
      return
    }
    setRepairing(true)
    try {
      const data = new Uint8Array(await file.arrayBuffer())
      await api.invoke('resource:replace', { projectId: tab.projectId, resourceId: tab.refId, data })
      await load()
      await refreshWorkspace()
      toast.success(t('resource.reimported'))
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setRepairing(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <input
        ref={fileInput}
        type="file"
        accept=".txt,.md,.csv"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void reimport(file)
          event.target.value = ''
        }}
      />
      <div className="flex items-center gap-2 border-b px-3 py-1.5" style={{ background: 'var(--panel)', borderColor: 'var(--border)' }}>
        <span className="text-sm font-medium">{tab.title}</span>
        <span className="text-xs" style={{ color: 'var(--muted)' }}>
          {t('resource.readonly')}
        </span>
        {encoding && !encoding.suspicious && (
          <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
            {t('resource.encoding', { encoding: encoding.encoding.toUpperCase() })}
          </span>
        )}
      </div>
      {encoding?.suspicious && (
        <div className="m-3 flex items-start gap-2 rounded border px-3 py-2 text-sm" style={{ borderColor: 'var(--warn)', background: 'var(--panel2)' }}>
          <AlertTriangle className="mt-0.5 shrink-0" size={16} style={{ color: 'var(--warn)' }} />
          <div className="min-w-0 flex-1">
            <div className="font-medium">{t('resource.encodingWarning')}</div>
            <div className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
              {t('resource.encodingWarningHint')}
            </div>
          </div>
          <button className="btn !py-1 text-xs" disabled={repairing} onClick={() => fileInput.current?.click()}>
            <RefreshCw size={12} className={repairing ? 'animate-spin' : ''} />
            {repairing ? t('resource.reimporting') : t('resource.reimport')}
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {loading ? (
          <div className="text-sm" style={{ color: 'var(--muted)' }}>
            {t('resource.loading')}
          </div>
        ) : (
          <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed">{content}</pre>
        )}
      </div>
    </div>
  )
}
