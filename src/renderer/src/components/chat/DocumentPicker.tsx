import { FileText } from 'lucide-react'
import type { DocMeta } from '@shared/types'
import { useAppStore } from '../../store/app.store'
import { useT } from '../../i18n'
import Modal from '../common/Modal'

interface Props {
  projectId: string
  onSelect: (doc: DocMeta) => void
  onClose: () => void
}

export default function DocumentPicker({ projectId, onSelect, onClose }: Props): JSX.Element {
  const t = useT()
  const docs = useAppStore((s) => s.workspace.projects.find((p) => p.project.id === projectId)?.docs ?? [])

  return (
    <Modal
      title={t('chat.selectDocTitle')}
      onClose={onClose}
      footer={
        <button className="btn" onClick={onClose}>
          {t('upload.close')}
        </button>
      }
    >
      <div className="max-h-80 overflow-y-auto rounded-lg border" style={{ borderColor: 'var(--border)' }}>
        {docs.length === 0 && (
          <div className="px-3 py-4 text-center text-xs" style={{ color: 'var(--muted)' }}>
            {t('chat.noDocsToAttach')}
          </div>
        )}
        {docs.map((doc) => (
          <button
            key={doc.id}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--panel3)]"
            onClick={() => onSelect(doc)}
          >
            <FileText size={14} style={{ color: 'var(--muted)' }} />
            <span className="min-w-0 flex-1 truncate">{doc.title}</span>
          </button>
        ))}
      </div>
      <p className="mt-2 text-[11px]" style={{ color: 'var(--muted)' }}>
        {t('chat.selectDocHint')}
      </p>
    </Modal>
  )
}
