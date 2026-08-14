import { useEffect, useState } from 'react'
import type { Tab } from '../store/app.store'
import { api } from '../lib/api'

export default function ResourceViewer({ tab }: { tab: Tab }): JSX.Element {
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
          资源文件（只读）
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {loading ? (
          <div className="text-sm" style={{ color: 'var(--muted)' }}>
            加载中…
          </div>
        ) : (
          <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed">{content}</pre>
        )}
      </div>
    </div>
  )
}
