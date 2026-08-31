import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { AlertTriangle, FolderOpen, Search, Upload } from 'lucide-react'
import type { ResourceImportConflict } from '@shared/types'
import type { Tab } from '../store/app.store'
import { useAppStore } from '../store/app.store'
import { api } from '../lib/api'
import { buildExtensions } from './editor/editor-setup'
import { flushDoc } from '../lib/editorRegistry'
import { chooseOption } from '../store/dialog.store'
import { toast } from '../store/toast.store'
import { useT } from '../i18n'
import Modal from './common/Modal'

function countCharacters(text: string): number {
  return Array.from(text).length
}

export default function ExternalResourceViewer({ tab }: { tab: Tab }): JSX.Element {
  const t = useT()
  const external = tab.externalFile!
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const setDirty = useAppStore((state) => state.setDirty)
  const dirty = useAppStore((state) => Boolean(state.dirty[tab.id]))
  const workspace = useAppStore((state) => state.workspace)
  const refreshWorkspace = useAppStore((state) => state.refreshWorkspace)
  const promoteExternalResource = useAppStore((state) => state.promoteExternalResource)
  const [characterCount, setCharacterCount] = useState(() => countCharacters(external.content))
  const [uploadOpen, setUploadOpen] = useState(false)
  const [projectSearch, setProjectSearch] = useState('')
  const [uploading, setUploading] = useState(false)

  useEffect(() => {
    if (!containerRef.current) return
    setDirty(tab.id, false)
    const state = EditorState.create({
      doc: external.content,
      extensions: [
        buildExtensions(() => true),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return
          setDirty(tab.id, true)
          setCharacterCount(countCharacters(update.state.doc.toString()))
        }),
        EditorView.theme({
          '&': { height: '100%', fontSize: '14px' },
          '.cm-scroller': { fontFamily: 'inherit', overflow: 'auto' },
          '.cm-content': { padding: '18px 20px 40px' }
        })
      ]
    })
    viewRef.current = new EditorView({ state, parent: containerRef.current })
    return () => {
      viewRef.current?.destroy()
      viewRef.current = null
    }
  }, [external.content, setDirty, tab.id])

  const projects = useMemo(() => {
    const query = projectSearch.trim().toLocaleLowerCase()
    return workspace.projects.filter((item) => !query || item.project.name.toLocaleLowerCase().includes(query))
  }, [projectSearch, workspace.projects])

  const uploadToProject = useCallback(async (projectId: string): Promise<void> => {
    const project = workspace.projects.find((item) => item.project.id === projectId)
    if (!project || !viewRef.current) return
    let conflict: ResourceImportConflict = 'rename'
    const existing = project.resources.find((resource) => resource.name.toLocaleLowerCase() === external.name.toLocaleLowerCase())
    if (existing) {
      const choice = await chooseOption(t('external.conflictPrompt', { name: external.name }), [
        { value: 'overwrite', label: t('external.overwrite') },
        { value: 'rename', label: t('external.renameImport') }
      ])
      if (choice !== 'overwrite' && choice !== 'rename') return
      conflict = choice
    }
    setUploading(true)
    try {
      if (conflict === 'overwrite' && existing) await flushDoc(existing.id)
      const resource = await api.invoke('resource:importExternal', {
        projectId,
        name: external.name,
        data: new Uint8Array(external.data),
        content: viewRef.current.state.doc.toString(),
        conflict
      })
      setDirty(tab.id, false)
      setUploadOpen(false)
      await refreshWorkspace()
      promoteExternalResource(tab.id, resource)
      toast.success(t('external.uploaded', { project: project.project.name }))
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setUploading(false)
    }
  }, [external.data, external.name, promoteExternalResource, refreshWorkspace, setDirty, t, tab.id, workspace.projects])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-1.5" style={{ background: 'var(--panel)', borderColor: 'var(--border)' }}>
        <span className="min-w-0 truncate text-sm font-medium">{external.name}</span>
        <span className="text-xs" style={{ color: 'var(--muted)' }}>{t('external.temporary')}</span>
        {external.sourceFormat && <span className="text-[11px] uppercase" style={{ color: 'var(--muted)' }}>{external.sourceFormat}</span>}
        {dirty && <span className="text-xs" style={{ color: 'var(--warn)' }}>● {t('editor.unsaved')}</span>}
        <span className="flex-1" />
        <button className="btn btn-primary !py-1 text-xs" onClick={() => setUploadOpen(true)}>
          <Upload size={13} />
          {t('external.upload')}
        </button>
      </div>
      <div className="flex items-center gap-2 border-b px-3 py-1.5 text-[11px]" style={{ color: 'var(--muted)', borderColor: 'var(--border)', background: 'var(--panel2)' }}>
        <FolderOpen size={12} />
        <span className="min-w-0 truncate" title={external.path}>{external.path}</span>
        <span className="ml-auto shrink-0">{t('external.copyHint')}</span>
      </div>
      {(external.warnings?.length ?? 0) > 0 && (
        <div className="m-3 flex items-start gap-2 rounded border px-3 py-2 text-xs" style={{ borderColor: 'var(--warn)', background: 'var(--panel2)', color: 'var(--muted)' }}>
          <AlertTriangle className="mt-0.5 shrink-0" size={14} style={{ color: 'var(--warn)' }} />
          <div>{external.warnings?.map((warning) => <div key={warning}>{warning}</div>)}</div>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="h-full" />
        <div className="pointer-events-none absolute bottom-2 right-4 rounded px-2 py-1 text-[11px]" style={{ color: 'var(--muted)', background: 'color-mix(in srgb, var(--panel) 88%, transparent)' }}>
          {t('resource.characters', { n: characterCount })}
        </div>
      </div>

      {uploadOpen && (
        <Modal
          title={t('external.chooseProject')}
          onClose={() => !uploading && setUploadOpen(false)}
          footer={<button className="btn" disabled={uploading} onClick={() => setUploadOpen(false)}>{t('dialog.cancel')}</button>}
        >
          <div className="mb-3 flex items-center gap-2 rounded-lg border px-2.5" style={{ borderColor: 'var(--border)', background: 'var(--panel2)' }}>
            <Search size={14} style={{ color: 'var(--muted)' }} />
            <input
              className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none"
              value={projectSearch}
              onChange={(event) => setProjectSearch(event.target.value)}
              placeholder={t('external.searchProject')}
              autoFocus
            />
          </div>
          <div className="max-h-72 overflow-y-auto rounded-lg border" style={{ borderColor: 'var(--border)' }}>
            {projects.length === 0 && <div className="px-3 py-6 text-center text-xs" style={{ color: 'var(--muted)' }}>{t('settings.noProjects')}</div>}
            {projects.map((item) => (
              <button
                key={item.project.id}
                className="flex w-full items-center gap-2 border-b px-3 py-2.5 text-left text-sm last:border-b-0 hover:bg-[var(--panel3)]"
                style={{ borderColor: 'var(--border)' }}
                disabled={uploading}
                onClick={() => void uploadToProject(item.project.id)}
              >
                <FolderOpen size={14} style={{ color: 'var(--muted)' }} />
                <span className="min-w-0 flex-1 truncate">{item.project.name}</span>
                <span className="text-[11px]" style={{ color: 'var(--muted)' }}>{t('external.resourceCount', { n: item.resources.length })}</span>
              </button>
            ))}
          </div>
          {uploading && <div className="mt-3 text-center text-xs" style={{ color: 'var(--muted)' }}>{t('external.uploading')}</div>}
        </Modal>
      )}
    </div>
  )
}
