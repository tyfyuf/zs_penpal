import { X } from 'lucide-react'
import { useAppStore } from '../../store/app.store'
import { flushDoc } from '../../lib/editorRegistry'
import { confirmDialog } from '../../store/dialog.store'
import { useT } from '../../i18n'

export default function Tabs(): JSX.Element {
  const t = useT()
  const tabs = useAppStore((s) => s.tabs)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const dirty = useAppStore((s) => s.dirty)
  const activateTab = useAppStore((s) => s.activateTab)
  const closeTab = useAppStore((s) => s.closeTab)

  async function handleClose(tab: (typeof tabs)[number]): Promise<void> {
    const dirtyKey = tab.kind === 'external-resource' ? tab.id : tab.refId
    const isDirty = Boolean(dirtyKey && dirty[dirtyKey])
    if (isDirty && tab.kind === 'external-resource') {
      const discard = await confirmDialog(t('tabs.externalUnsavedClose'))
      if (!discard) return
      closeTab(tab.id)
      return
    }
    if (isDirty && dirtyKey && (tab.kind === 'doc' || tab.kind === 'resource')) {
      const save = await confirmDialog(t('tabs.unsavedClose'))
      if (save) {
        void flushDoc(dirtyKey).then(() => closeTab(tab.id))
        return
      }
    }
    closeTab(tab.id)
  }

  if (tabs.length === 0) return <div style={{ height: 38, background: 'var(--panel)' }} />

  return (
    <div className="flex items-end overflow-x-auto" style={{ height: 38, background: 'var(--panel)', borderBottom: '1px solid var(--border)' }}>
      {tabs.map((t) => {
        const isActive = t.id === activeTabId
        const dirtyKey = t.kind === 'external-resource' ? t.id : t.refId
        const isDirty = Boolean(dirtyKey && dirty[dirtyKey])
        return (
          <div
            key={t.id}
            className="flex h-full cursor-pointer select-none items-center gap-2 border-r px-3 text-sm"
            style={{
              background: isActive ? 'var(--bg)' : 'transparent',
              borderColor: 'var(--border)',
              color: isActive ? 'var(--text)' : 'var(--muted)'
            }}
            onClick={() => activateTab(t.id)}
            title={t.title}
          >
            <span className="max-w-[160px] truncate">
              {isDirty ? '● ' : ''}
              {t.title}
            </span>
            <button
              className="rounded p-0.5 hover:opacity-70"
              style={{ color: 'var(--muted)' }}
              onClick={(e) => {
                e.stopPropagation()
                handleClose(t)
              }}
            >
              <X size={14} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
