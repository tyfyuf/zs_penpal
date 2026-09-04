import { useCallback, useEffect, useRef, useState } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { AlertTriangle, RefreshCw, Save } from 'lucide-react'
import type { ResourceMeta, TextEncodingInfo } from '@shared/types'
import { RESOURCE_FILE_ACCEPT, isSupportedResourceFile } from '@shared/resource-formats'
import type { Tab } from '../store/app.store'
import { useAppStore } from '../store/app.store'
import { api } from '../lib/api'
import { buildExtensions } from './editor/editor-setup'
import { registerSaveHandler } from '../lib/editorRegistry'
import { confirmDialog } from '../store/dialog.store'
import { toast } from '../store/toast.store'
import { useT } from '../i18n'

function countCharacters(text: string): number {
  return Array.from(text).length
}

export default function ResourceViewer({ tab }: { tab: Tab }): JSX.Element {
  const t = useT()
  const resourceId = tab.refId!
  const projectId = tab.projectId!
  const containerRef = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const loadedRef = useRef(false)
  const suppressChangesRef = useRef(false)
  const savePromise = useRef<Promise<void> | null>(null)
  const lastSavedContentRef = useRef<string | null>(null)
  const editableCompartment = useRef(new Compartment())
  const distillingRef = useRef(false)
  const dirty = useAppStore((state) => Boolean(state.dirty[resourceId]))
  const setDirty = useAppStore((state) => state.setDirty)
  const refreshWorkspace = useAppStore((state) => state.refreshWorkspace)
  const bumpSummary = useAppStore((state) => state.bumpSummary)
  const [encoding, setEncoding] = useState<TextEncodingInfo | null>(null)
  const [meta, setMeta] = useState<ResourceMeta | null>(null)
  const [loading, setLoading] = useState(true)
  const [repairing, setRepairing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [characterCount, setCharacterCount] = useState(0)
  const [distilling, setDistilling] = useState(false)

  const doSave = useCallback(async (): Promise<void> => {
    if (distillingRef.current || !viewRef.current || !loadedRef.current) return
    if (savePromise.current) return savePromise.current
    if (viewRef.current.state.doc.toString() === lastSavedContentRef.current) {
      setDirty(resourceId, false)
      return
    }

    const pending = (async (): Promise<void> => {
      setSaving(true)
      try {
        while (viewRef.current && loadedRef.current && !distillingRef.current) {
          const content = viewRef.current.state.doc.toString()
          if (content === lastSavedContentRef.current) {
            setDirty(resourceId, false)
            break
          }

          const next = await api.invoke('resource:saveText', { projectId, resourceId, content })
          lastSavedContentRef.current = content
          setMeta(next)
          bumpSummary()

          if (viewRef.current?.state.doc.toString() === content) {
            setDirty(resourceId, false)
            break
          }
          setDirty(resourceId, true)
        }
      } catch (error) {
        setDirty(resourceId, true)
        toast.error((error as Error).message)
        throw error
      } finally {
        savePromise.current = null
        setSaving(false)
      }
    })()

    savePromise.current = pending
    return pending
  }, [bumpSummary, projectId, resourceId, setDirty])

  useEffect(() => {
    let cancelled = false
    void api
      .invoke('summary:listProject', projectId)
      .then((overview) => {
        if (cancelled) return
        const generating = overview.resources.some((resource) => resource.resourceId === resourceId && resource.generating)
        distillingRef.current = generating
        setDistilling(generating)
      })
      .catch(() => undefined)
    const off = api.on('summary:status', (payload) => {
      if (payload.key !== `res:${resourceId}`) return
      distillingRef.current = payload.generating
      setDistilling(payload.generating)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [projectId, resourceId])

  useEffect(() => {
    const view = viewRef.current
    if (view) {
      view.dispatch({
        effects: editableCompartment.current.reconfigure([
          EditorView.editable.of(!distilling),
          EditorState.readOnly.of(distilling)
        ])
      })
    }
  }, [distilling])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setDirty(resourceId, false)
    void api
      .invoke('resource:read', { projectId, resourceId })
      .then((result) => {
        if (cancelled || !containerRef.current) return
        setEncoding(result.encoding)
        setMeta(result.meta)
        setCharacterCount(countCharacters(result.content))
        lastSavedContentRef.current = result.content
        const state = EditorState.create({
          doc: result.content,
          extensions: [
            editableCompartment.current.of([
              EditorView.editable.of(!distillingRef.current),
              EditorState.readOnly.of(distillingRef.current)
            ]),
            buildExtensions(() => {
              void doSave().catch(() => undefined)
              return true
            }),
            EditorView.updateListener.of((update) => {
              if (!update.docChanged || suppressChangesRef.current) return
              setDirty(resourceId, true)
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
        loadedRef.current = true
        setLoading(false)
      })
      .catch((error) => {
        if (!cancelled) {
          setLoading(false)
          toast.error((error as Error).message)
        }
      })

    const unregister = registerSaveHandler(resourceId, doSave)
    return () => {
      cancelled = true
      unregister()
      viewRef.current?.destroy()
      viewRef.current = null
      loadedRef.current = false
      lastSavedContentRef.current = null
    }
  }, [doSave, projectId, resourceId, setDirty])

  async function reimport(file: File): Promise<void> {
    if (distillingRef.current) {
      toast.error(t('resource.distilling'))
      return
    }
    if (!isSupportedResourceFile(file.name)) {
      toast.error(t('sidebar.badExt'))
      return
    }
    if (meta?.contentEditedAt) {
      const confirmed = await confirmDialog(t('resource.reimportOverwriteConfirm'))
      if (!confirmed) return
    }
    if (savePromise.current) {
      try {
        await savePromise.current
      } catch {
        return
      }
    }
    setRepairing(true)
    try {
      const data = new Uint8Array(await file.arrayBuffer())
      await api.invoke('resource:replace', { projectId, resourceId, data, sourceName: file.name })
      const result = await api.invoke('resource:read', { projectId, resourceId })
      const view = viewRef.current
      if (view) {
        suppressChangesRef.current = true
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: result.content } })
        suppressChangesRef.current = false
      }
      lastSavedContentRef.current = result.content
      setMeta(result.meta)
      setEncoding(result.encoding)
      setCharacterCount(countCharacters(result.content))
      setDirty(resourceId, false)
      bumpSummary()
      await refreshWorkspace()
      toast.success(t('resource.reimported'))
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      suppressChangesRef.current = false
      setRepairing(false)
    }
  }

  const warnings = meta?.conversionWarnings ?? []

  return (
    <div className="flex h-full flex-col">
      <input
        ref={fileInput}
        type="file"
        accept={RESOURCE_FILE_ACCEPT}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void reimport(file)
          event.target.value = ''
        }}
      />
      <div className="flex items-center gap-2 border-b px-3 py-1.5" style={{ background: 'var(--panel)', borderColor: 'var(--border)' }}>
        <span className="min-w-0 truncate text-sm font-medium">{tab.title}</span>
        <span className="text-xs" style={{ color: 'var(--muted)' }}>
          {t('resource.editable')}
        </span>
        {meta?.sourceFormat && (
          <span className="text-[11px] uppercase" style={{ color: 'var(--muted)' }}>
            {meta.sourceFormat}
          </span>
        )}
        {encoding && !encoding.suspicious && meta?.sourceFormat !== 'doc' && meta?.sourceFormat !== 'docx' && (
          <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
            {t('resource.encoding', { encoding: encoding.encoding.toUpperCase() })}
          </span>
        )}
        {dirty && <span className="text-xs" style={{ color: 'var(--warn)' }}>● {t('editor.unsaved')}</span>}
        {saving && <span className="text-xs" style={{ color: 'var(--muted)' }}>{t('resource.saving')}</span>}
        {distilling && <span className="text-xs" style={{ color: 'var(--warn)' }}>{t('resource.distilling')}</span>}
        <span className="flex-1" />
        <button className="btn !px-2 !py-1" disabled={saving || loading || distilling} onClick={() => void doSave().catch(() => undefined)} title={distilling ? t('resource.distilling') : t('editor.save')}>
          <Save size={14} />
        </button>
        <button className="btn !py-1 text-xs" disabled={repairing || distilling} onClick={() => fileInput.current?.click()}>
          <RefreshCw size={12} className={repairing ? 'animate-spin' : ''} />
          {repairing ? t('resource.reimporting') : t('resource.reimport')}
        </button>
      </div>
      {encoding?.suspicious && (
        <div className="m-3 flex items-start gap-2 rounded border px-3 py-2 text-sm" style={{ borderColor: 'var(--warn)', background: 'var(--panel2)' }}>
          <AlertTriangle className="mt-0.5 shrink-0" size={16} style={{ color: 'var(--warn)' }} />
          <div className="min-w-0 flex-1">
            <div className="font-medium">{t('resource.encodingWarning')}</div>
            <div className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>{t('resource.encodingWarningHint')}</div>
          </div>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="mx-3 mt-3 rounded border px-3 py-2 text-xs" style={{ borderColor: 'var(--border)', background: 'var(--panel2)', color: 'var(--muted)' }}>
          {warnings.map((warning) => <div key={warning}>{warning}</div>)}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {loading && <div className="absolute inset-0 z-10 p-4 text-sm" style={{ color: 'var(--muted)', background: 'var(--bg)' }}>{t('resource.loading')}</div>}
        <div ref={containerRef} className="h-full" />
        <div className="pointer-events-none absolute bottom-2 right-4 rounded px-2 py-1 text-[11px]" style={{ color: 'var(--muted)', background: 'color-mix(in srgb, var(--panel) 88%, transparent)' }}>
          {t('resource.characters', { n: characterCount })}
        </div>
      </div>
    </div>
  )
}
