import { useRef, useState } from 'react'
import { FileText, Upload } from 'lucide-react'
import type { UploadResult } from '@shared/types'
import { RESOURCE_FILE_ACCEPT, isSupportedResourceFile } from '@shared/resource-formats'
import { useAppStore } from '../../store/app.store'
import { api } from '../../lib/api'
import { toast } from '../../store/toast.store'
import { useT } from '../../i18n'
import Modal from '../common/Modal'

interface Props {
  chatId: string
  projectId: string
  onAttached: (r: UploadResult) => void
  onClose: () => void
}


export default function UploadPicker({ chatId, projectId, onAttached, onClose }: Props): JSX.Element {
  const t = useT()
  const resources = useAppStore((s) => s.workspace.projects.find((p) => p.project.id === projectId)?.resources ?? [])
  const fileInput = useRef<HTMLInputElement>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase()
  const filteredResources = normalizedQuery
    ? resources.filter((resource) => resource.name.toLocaleLowerCase().includes(normalizedQuery))
    : resources

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
    if (!isSupportedResourceFile(file.name)) {
      toast.error(t('sidebar.badExt'))
      return
    }
    const data = new Uint8Array(await file.arrayBuffer())
    try {
      const r = await api.invoke('chat:attachResource', { chatId, projectId, source: { mode: 'local', name: file.name, data } })
      onAttached(r)
      onClose()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  return (
    <Modal
      title={t('upload.title')}
      onClose={onClose}
      footer={
        <button className="btn" onClick={onClose}>
          {t('upload.close')}
        </button>
      }
    >
      <input
        ref={fileInput}
        type="file"
        accept={RESOURCE_FILE_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void attachLocal(f)
          e.target.value = ''
        }}
      />
      <button className="btn mb-3 w-full" onClick={() => fileInput.current?.click()}>
        <Upload size={14} />
        {t('upload.local')}
      </button>

      <div className="mb-1 text-xs" style={{ color: 'var(--muted)' }}>
        {t('upload.fromResources')}
      </div>
      <input
        className="input mb-2"
        placeholder={t('upload.searchResources')}
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
      />
      <div className="max-h-64 overflow-y-auto rounded-lg border" style={{ borderColor: 'var(--border)' }}>
        {resources.length === 0 && (
          <div className="px-3 py-4 text-center text-xs" style={{ color: 'var(--muted)' }}>
            {t('upload.empty')}
          </div>
        )}
        {resources.length > 0 && filteredResources.length === 0 && (
          <div className="px-3 py-4 text-center text-xs" style={{ color: 'var(--muted)' }}>
            {t('upload.noMatchingResources')}
          </div>
        )}
        {filteredResources.map((r) => (
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
        {t('upload.hint')}
      </p>
    </Modal>
  )
}
