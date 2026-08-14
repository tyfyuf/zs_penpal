import { useRef } from 'react'
import { FileText, Upload } from 'lucide-react'
import type { UploadResult } from '@shared/types'
import { useAppStore } from '../../store/app.store'
import { api } from '../../lib/api'
import { toast } from '../../store/toast.store'
import Modal from '../common/Modal'

interface Props {
  chatId: string
  projectId: string
  onAttached: (r: UploadResult) => void
  onClose: () => void
}

const ALLOWED_EXT = ['.txt', '.md', '.csv']

export default function UploadPicker({ chatId, projectId, onAttached, onClose }: Props): JSX.Element {
  const resources = useAppStore((s) => s.workspace.projects.find((p) => p.project.id === projectId)?.resources ?? [])
  const fileInput = useRef<HTMLInputElement>(null)

  async function attachResource(resourceId: string): Promise<void> {
    try {
      const r = await api.invoke('chat:attachResource', { chatId, projectId, source: { mode: 'resource', resourceId } })
      onAttached(r)
      onClose()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function attachLocal(file: File): Promise<void> {
    const ext = '.' + file.name.split('.').pop()?.toLowerCase()
    if (!ALLOWED_EXT.includes(ext)) {
      toast.error('仅支持 .txt / .md / .csv 文本文件')
      return
    }
    const content = await file.text()
    try {
      const r = await api.invoke('chat:attachResource', { chatId, projectId, source: { mode: 'local', name: file.name, content } })
      onAttached(r)
      onClose()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  return (
    <Modal
      title="上传文件到会话"
      onClose={onClose}
      footer={
        <button className="btn" onClick={onClose}>
          关闭
        </button>
      }
    >
      <input
        ref={fileInput}
        type="file"
        accept=".txt,.md,.csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void attachLocal(f)
          e.target.value = ''
        }}
      />
      <button className="btn mb-3 w-full" onClick={() => fileInput.current?.click()}>
        <Upload size={14} />
        从本地上传（自动加入资源区）
      </button>

      <div className="mb-1 text-xs" style={{ color: 'var(--muted)' }}>
        从资源区选取
      </div>
      <div className="max-h-64 overflow-y-auto rounded-lg border" style={{ borderColor: 'var(--border)' }}>
        {resources.length === 0 && (
          <div className="px-3 py-4 text-center text-xs" style={{ color: 'var(--muted)' }}>
            当前项目暂无资源文件
          </div>
        )}
        {resources.map((r) => (
          <button
            key={r.id}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--panel3)]"
            onClick={() => void attachResource(r.id)}
          >
            <FileText size={14} style={{ color: 'var(--muted)' }} />
            <span className="min-w-0 flex-1 truncate">{r.name}</span>
          </button>
        ))}
      </div>
      <p className="mt-2 text-[11px]" style={{ color: 'var(--muted)' }}>
        文件仅对本次会话有效；上传时保存内容快照，后续修改原文件不影响本会话。
      </p>
    </Modal>
  )
}
