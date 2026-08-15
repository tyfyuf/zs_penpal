import { useEffect, useState } from 'react'
import type { Tab } from '../store/app.store'
import { api } from '../lib/api'
import { useT } from '../i18n'

export default function ResourceViewer({ tab }: { tab: Tab }): JSX.Element {
  const t = useT()
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!tab.refId || !tab.projectId) return
    void api.invoke('resource:read', { projectId: tab.projectId, resourceId: tab.refId }).then((res) => {
      setContent(res.content)
      setLoading(false)
    })
  }, [tab.refId, tab.projectId])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-1.5" style={{ background: 'var(--panel)', borderColor: 'var(--border)' }}>
        <span className="text-sm font-medium">{tab.title}</span>
        <span className="text-xs" style={{ color: 'var(--muted)' }}>
          {t('resource.readonly')}
        </span>
      </div>
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
