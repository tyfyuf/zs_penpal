import { useCallback, useEffect, useRef, useState } from 'react'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import { Download, Minus, Plus, Save } from 'lucide-react'
import type { ContextRange, DocMeta } from '@shared/types'
import type { Tab } from '../../store/app.store'
import { useAppStore } from '../../store/app.store'
import { useContextStore, type ContextHighlight } from '../../store/context.store'
import { api } from '../../lib/api'
import { registerSaveHandler } from '../../lib/editorRegistry'
import { toast } from '../../store/toast.store'
import { buildExtensions } from './editor-setup'

type Action = '诊断' | '走向' | '优化'

interface MenuState {
  x: number
  y: number
  from: number
  to: number
  empty: boolean
}

function buildHighlightDecos(h: ContextHighlight, docLen: number): Extension {
  const hasSel = h.selectionFrom !== undefined && h.selectionTo !== undefined && h.selectionTo > h.selectionFrom
  const coreStart = hasSel ? h.selectionFrom! : h.anchor
  const coreEnd = hasSel ? h.selectionTo! : h.anchor
  const beforeStart = Math.max(0, coreStart - h.before)
  const afterEnd = Math.min(docLen, coreEnd + h.after)
  const ranges = []
  if (beforeStart < coreStart) ranges.push(Decoration.mark({ class: 'cm-context-before' }).range(beforeStart, coreStart))
  if (coreStart < coreEnd) ranges.push(Decoration.mark({ class: 'cm-context-core' }).range(coreStart, coreEnd))
  if (coreEnd < afterEnd) ranges.push(Decoration.mark({ class: 'cm-context-after' }).range(coreEnd, afterEnd))
  return EditorView.decorations.of(Decoration.set(ranges, true))
}

export default function EditorPane({ tab }: { tab: Tab }): JSX.Element {
  const docId = tab.refId!
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const lineEndingRef = useRef<'LF' | 'CRLF'>('LF')
  const loadedRef = useRef(false)
  const highlightCompartment = useRef(new Compartment())
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [docMeta, setDocMeta] = useState<DocMeta | null>(null)
  const [fontSize, setFontSize] = useState(15)
  const [menu, setMenu] = useState<MenuState | null>(null)

  const config = useAppStore((s) => s.config)
  const dirty = useAppStore((s) => s.dirty[docId])
  const setDirty = useAppStore((s) => s.setDirty)
  const refresh = useAppStore((s) => s.refreshWorkspace)
  const openChat = useAppStore((s) => s.openChat)
  const highlight = useContextStore((s) => s.highlight)

  const doSave = useCallback(async (): Promise<void> => {
    const view = viewRef.current
    if (!view || !loadedRef.current) return
    let text = view.state.doc.toString()
    if (lineEndingRef.current === 'CRLF') text = text.replace(/\n/g, '\r\n')
    try {
      await api.invoke('doc:save', { docId, content: text })
      setDirty(docId, false)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }, [docId, setDirty])

  const scheduleSave = useCallback((): void => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    const interval = config?.autosaveIntervalMs ?? 5000
    saveTimer.current = setTimeout(() => {
      void doSave()
    }, interval)
  }, [config?.autosaveIntervalMs, doSave])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { doc, content } = await api.invoke('doc:read', docId)
      if (cancelled) return
      setDocMeta(doc)
      if (content.includes('\r\n')) lineEndingRef.current = 'CRLF'
      else lineEndingRef.current = 'LF'

      const state = EditorState.create({
        doc: content,
        extensions: [
          buildExtensions(() => {
            void doSave()
            return true
          }),
          highlightCompartment.current.of([]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && loadedRef.current) {
              setDirty(docId, true)
              scheduleSave()
            }
          }),
          EditorView.theme({
            '&': { height: '100%' },
            '.cm-scroller': { fontFamily: 'inherit', overflow: 'auto' }
          })
        ]
      })
      const view = new EditorView({
        state,
        parent: containerRef.current!
      })
      viewRef.current = view
      loadedRef.current = true
    })()

    const unregister = registerSaveHandler(docId, doSave)

    return () => {
      cancelled = true
      unregister()
      if (saveTimer.current) clearTimeout(saveTimer.current)
      viewRef.current?.destroy()
      viewRef.current = null
      loadedRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId])

  // 上下文高亮（PRD 6.4）
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (!highlight || highlight.docId !== docId) {
      view.dispatch({ effects: highlightCompartment.current.reconfigure([]) })
      return
    }
    view.dispatch({ effects: highlightCompartment.current.reconfigure(buildHighlightDecos(highlight, view.state.doc.length)) })
  }, [highlight, docId])

  function onContextMenu(e: React.MouseEvent): void {
    e.preventDefault()
    const view = viewRef.current
    if (!view) return
    const coords = { x: e.clientX, y: e.clientY }
    const pos = view.posAtCoords(coords)
    if (pos == null) return
    const sel = view.state.selection.main
    if (pos < sel.from || pos > sel.to) {
      view.dispatch({ selection: { anchor: pos } })
    }
    const cur = view.state.selection.main
    setMenu({ x: e.clientX, y: e.clientY, from: cur.from, to: cur.to, empty: cur.empty })
  }

  async function runAction(action: Action): Promise<void> {
    const view = viewRef.current
    const m = menu
    setMenu(null)
    if (!view || !m || !docMeta) return
    const docLength = view.state.doc.length
    const hasSelection = !m.empty
    const anchor = hasSelection ? m.from : m.to
    let before = 200
    let after = 200
    if (action === '走向') {
      before = 500
      after = m.to < docLength ? 200 : 0
    }
    const contextRange: ContextRange = {
      before,
      after,
      anchor,
      hasSelection,
      selectionFrom: hasSelection ? m.from : undefined,
      selectionTo: hasSelection ? m.to : undefined
    }
    try {
      const chat = await api.invoke('chat:create', {
        projectId: docMeta.projectId,
        kind: 'context',
        title: `${action} · ${tab.title}`,
        docId,
        contextRange
      })
      await refresh()
      openChat(chat)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function exportDoc(format: 'md' | 'txt'): Promise<void> {
    const res = await api.invoke('export:doc', { docId, format })
    if (res.ok) toast.success(`已导出：${res.path}`)
    else if (res.error !== '已取消') toast.error(res.error ?? '导出失败')
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-1.5" style={{ background: 'var(--panel)', borderColor: 'var(--border)' }}>
        <span className="text-sm font-medium">{tab.title}</span>
        {dirty && (
          <span className="text-xs" style={{ color: 'var(--warn)' }}>
            ● 未保存
          </span>
        )}
        <span className="flex-1" />
        <button className="btn !px-2 !py-1" onClick={() => setFontSize((f) => Math.max(12, f - 1))} title="缩小字号">
          <Minus size={14} />
        </button>
        <span className="w-8 text-center text-xs" style={{ color: 'var(--muted)' }}>
          {fontSize}
        </span>
        <button className="btn !px-2 !py-1" onClick={() => setFontSize((f) => Math.min(28, f + 1))} title="放大字号">
          <Plus size={14} />
        </button>
        <button className="btn !px-2 !py-1" onClick={() => void doSave()} title="保存 (Ctrl+S)">
          <Save size={14} />
        </button>
        <button className="btn !px-2 !py-1" onClick={() => void exportDoc('md')} title="导出 Markdown">
          <Download size={14} />
        </button>
      </div>

      <div
        className="min-h-0 flex-1"
        style={{ ['--cm-font-size' as string]: `${fontSize}px` }}
        onContextMenu={onContextMenu}
        onClick={() => menu && setMenu(null)}
      >
        <div ref={containerRef} className="h-full" />
      </div>

      {menu && (
        <div
          className="fixed z-50 w-32 rounded-lg border py-1 shadow-xl"
          style={{ left: menu.x, top: menu.y, background: 'var(--panel2)', borderColor: 'var(--border)' }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {(['诊断', '走向', ...(menu.empty ? [] : ['优化'])] as Action[]).map((a) => (
            <button
              key={a}
              className="block w-full px-3 py-1.5 text-left text-sm hover:bg-[var(--panel3)]"
              onClick={() => void runAction(a)}
            >
              {a}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
