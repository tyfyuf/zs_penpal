import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import { AlignCenter, ClipboardPaste, Copy, Download, IndentIncrease, Minus, Plus, Save, Scissors, Stethoscope, TrendingUp, Wand2, type LucideIcon } from 'lucide-react'
import type { ChatAction, ContextRange, DocEditorFormat, DocMeta } from '@shared/types'
import type { Tab } from '../../store/app.store'
import { useAppStore } from '../../store/app.store'
import { useContextStore, type ContextHighlight } from '../../store/context.store'
import { api } from '../../lib/api'
import { registerSaveHandler } from '../../lib/editorRegistry'
import { toast } from '../../store/toast.store'
import { useT } from '../../i18n'
import {
  buildExtensions,
  centeredParagraphsExtension,
  firstLineIndentExtension,
  getCenteredParagraphs,
  isSelectedParagraphsCentered,
  setCenteredParagraphs,
  toggleSelectedParagraphsCentered
} from './editor-setup'

const ACTIONS: { value: ChatAction; labelKey: string; icon: LucideIcon }[] = [
  { value: 'diagnose', labelKey: 'sidebar.actionDiagnose', icon: Stethoscope },
  { value: 'plot', labelKey: 'sidebar.actionPlot', icon: TrendingUp },
  { value: 'optimize', labelKey: 'sidebar.actionOptimize', icon: Wand2 }
]

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


interface CharacterStats {
  total: number
  nonWhitespace: number
}

function countCharacters(text: string): CharacterStats {
  let total = 0
  let nonWhitespace = 0
  for (const character of text) {
    total += 1
    if (!/\s/u.test(character)) nonWhitespace += 1
  }
  return { total, nonWhitespace }
}

function resolveCenteredParagraphs(content: string, format?: DocEditorFormat): { from: number; to: number }[] {
  if (!format || format.version !== 1) return []
  const ranges: { from: number; to: number }[] = []
  for (const paragraph of format.centeredParagraphs) {
    if (!paragraph.text) continue
    let from = paragraph.from
    if (content.slice(from, from + paragraph.text.length) !== paragraph.text) {
      let nearest = -1
      let nearestDistance = Number.POSITIVE_INFINITY
      let candidate = content.indexOf(paragraph.text)
      while (candidate !== -1) {
        const distance = Math.abs(candidate - paragraph.from)
        if (distance < nearestDistance) {
          nearest = candidate
          nearestDistance = distance
        }
        candidate = content.indexOf(paragraph.text, candidate + Math.max(1, paragraph.text.length))
      }
      if (nearest === -1) continue
      from = nearest
    }
    ranges.push({ from, to: from + paragraph.text.length })
  }
  return ranges
}

function buildEditorFormat(view: EditorView, firstLineIndent: boolean): DocEditorFormat {
  return {
    version: 1,
    firstLineIndent,
    centeredParagraphs: getCenteredParagraphs(view.state).map((paragraph) => ({
      from: paragraph.from,
      to: paragraph.to,
      text: view.state.doc.sliceString(paragraph.from, paragraph.to)
    }))
  }
}

export default function EditorPane({ tab }: { tab: Tab }): JSX.Element {
  const t = useT()
  const docId = tab.refId!
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const lineEndingRef = useRef<'LF' | 'CRLF'>('LF')
  const loadedRef = useRef(false)
  const highlightCompartment = useRef(new Compartment())
  const indentCompartment = useRef(new Compartment())
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savePromise = useRef<Promise<void> | null>(null)
  const statsTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const firstLineIndentRef = useRef(false)
  const centeredButtonRef = useRef(false)
  const readOnlyRef = useRef(false)

  const [docMeta, setDocMeta] = useState<DocMeta | null>(null)
  const [loading, setLoading] = useState(true)
  const [fontSize, setFontSize] = useState(15)
  const [firstLineIndent, setFirstLineIndent] = useState(false)
  const [centeredSelection, setCenteredSelection] = useState(false)
  const [characterStats, setCharacterStats] = useState<CharacterStats>({ total: 0, nonWhitespace: 0 })
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const config = useAppStore((s) => s.config)
  const dirty = useAppStore((s) => s.dirty[docId])
  const isReadOnly = docMeta?.system === 'feature-guide'
  const setDirty = useAppStore((s) => s.setDirty)
  const refresh = useAppStore((s) => s.refreshWorkspace)
  const openChat = useAppStore((s) => s.openChat)
  const highlight = useContextStore((s) => s.highlight)

  const syncCenteredButton = useCallback((view: EditorView | null): void => {
    if (!view) return
    const next = isSelectedParagraphsCentered(view.state)
    if (centeredButtonRef.current === next) return
    centeredButtonRef.current = next
    setCenteredSelection(next)
  }, [])

  const scheduleCharacterStats = useCallback((view: EditorView): void => {
    if (statsTimer.current) clearTimeout(statsTimer.current)
    statsTimer.current = setTimeout(() => {
      setCharacterStats(countCharacters(view.state.doc.toString()))
    }, 120)
  }, [])

  const doSave = useCallback(async (): Promise<void> => {
    if (savePromise.current) return savePromise.current
    const pending = (async (): Promise<void> => {
      try {
        while (viewRef.current && loadedRef.current && !readOnlyRef.current) {
          const view = viewRef.current
          let text = view.state.doc.toString()
          if (lineEndingRef.current === 'CRLF') text = text.replace(/\n/g, '\r\n')
          await api.invoke('doc:save', {
            docId,
            content: text,
            editorFormat: buildEditorFormat(view, firstLineIndentRef.current)
          })
          if (viewRef.current?.state.doc.toString() === text.replace(/\r\n/g, '\n')) {
            setDirty(docId, false)
            return
          }
          setDirty(docId, true)
        }
      } catch (err) {
        toast.error((err as Error).message)
        throw err
      } finally {
        savePromise.current = null
      }
    })()
    savePromise.current = pending
    return pending
  }, [docId, setDirty])

  const scheduleSave = useCallback((): void => {
    if (readOnlyRef.current) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    const interval = config?.autosaveIntervalMs ?? 5000
    saveTimer.current = setTimeout(() => {
      void doSave().catch(() => undefined)
    }, interval)
  }, [config?.autosaveIntervalMs, doSave])

  useEffect(() => {
    let cancelled = false
    firstLineIndentRef.current = false
    centeredButtonRef.current = false
    readOnlyRef.current = false
    setFirstLineIndent(false)
    setCenteredSelection(false)
    setCharacterStats({ total: 0, nonWhitespace: 0 })
    setLoading(true)
    void (async () => {
      const { doc, content } = await api.invoke('doc:read', docId)
      if (cancelled) return
      setDocMeta(doc)
      setLoading(false)
      const readOnly = doc.system === 'feature-guide'
      readOnlyRef.current = readOnly
      if (content.includes('\r\n')) lineEndingRef.current = 'CRLF'
      else lineEndingRef.current = 'LF'

      const state = EditorState.create({
        doc: content,
        extensions: [
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          buildExtensions(() => {
            void doSave().catch(() => undefined)
            return true
          }),
          highlightCompartment.current.of([]),
          indentCompartment.current.of(doc.editorFormat?.firstLineIndent ? firstLineIndentExtension : []),
          centeredParagraphsExtension,
          EditorView.updateListener.of((u) => {
            if (u.selectionSet) syncCenteredButton(u.view)
            if (u.docChanged && loadedRef.current) {
              setDirty(docId, true)
              scheduleSave()
              scheduleCharacterStats(u.view)
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
      const restoredCenteredParagraphs = resolveCenteredParagraphs(view.state.doc.toString(), doc.editorFormat)
      if (restoredCenteredParagraphs.length) view.dispatch({ effects: setCenteredParagraphs.of(restoredCenteredParagraphs) })
      firstLineIndentRef.current = Boolean(doc.editorFormat?.firstLineIndent)
      setFirstLineIndent(firstLineIndentRef.current)
      setCharacterStats(countCharacters(view.state.doc.toString()))
      viewRef.current = view
      loadedRef.current = true
      syncCenteredButton(view)
    })()

    const unregister = registerSaveHandler(docId, doSave)

    return () => {
      cancelled = true
      unregister()
      if (saveTimer.current) clearTimeout(saveTimer.current)
      if (statsTimer.current) clearTimeout(statsTimer.current)
      viewRef.current?.destroy()
      viewRef.current = null
      loadedRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId])

  // 上下文高亮（PRD 6.4）

  function markEditorFormatDirty(): void {
    if (readOnlyRef.current) return
    setDirty(docId, true)
    scheduleSave()
  }

  function toggleCenteredParagraphs(): void {
    if (readOnlyRef.current) return
    const view = viewRef.current
    if (!view || !toggleSelectedParagraphsCentered(view)) return
    syncCenteredButton(view)
    markEditorFormatDirty()
  }

  function toggleFirstLineIndent(): void {
    if (readOnlyRef.current) return
    const view = viewRef.current
    const next = !firstLineIndentRef.current
    firstLineIndentRef.current = next
    setFirstLineIndent(next)
    view?.dispatch({ effects: indentCompartment.current.reconfigure(next ? firstLineIndentExtension : []) })
    markEditorFormatDirty()
  }

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (!highlight || highlight.docId !== docId) {
      view.dispatch({ effects: highlightCompartment.current.reconfigure([]) })
      return
    }
    view.dispatch({ effects: highlightCompartment.current.reconfigure(buildHighlightDecos(highlight, view.state.doc.length)) })
  }, [highlight, docId])

  // 右键菜单边界钳制：靠近窗口边缘时自动回移，避免被截断
  useLayoutEffect(() => {
    if (!menu) {
      setMenuPos(null)
      return
    }
    setMenuPos({ x: menu.x, y: menu.y })
    if (!menuRef.current) return
    const rect = menuRef.current.getBoundingClientRect()
    let x = menu.x
    let y = menu.y
    if (x + rect.width > window.innerWidth - 4) x = Math.max(4, window.innerWidth - rect.width - 4)
    if (y + rect.height > window.innerHeight - 4) y = Math.max(4, window.innerHeight - rect.height - 4)
    setMenuPos({ x, y })
  }, [menu])

  function onContextMenu(e: React.MouseEvent): void {
    e.preventDefault()
    if (loading) return
    const view = viewRef.current
    if (!view) return
    const coords = { x: e.clientX, y: e.clientY }
    const pos = view.posAtCoords(coords)
    if (pos == null) return
    const sel = view.state.selection.main
    if (isReadOnly && sel.empty) return
    if (pos < sel.from || pos > sel.to) {
      view.dispatch({ selection: { anchor: pos } })
    }
    const cur = view.state.selection.main
    setMenu({ x: e.clientX, y: e.clientY, from: cur.from, to: cur.to, empty: cur.empty })
  }

  async function copySelection(): Promise<void> {
    const view = viewRef.current
    const m = menu
    setMenu(null)
    if (!view || !m || m.empty) return
    try {
      await api.invoke('clipboard:write', view.state.sliceDoc(m.from, m.to))
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function cutSelection(): Promise<void> {
    if (isReadOnly) return
    const view = viewRef.current
    const m = menu
    setMenu(null)
    if (!view || !m || m.empty) return
    try {
      await api.invoke('clipboard:write', view.state.sliceDoc(m.from, m.to))
      view.dispatch({ changes: { from: m.from, to: m.to, insert: '' } })
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function pasteAtCursor(): Promise<void> {
    if (isReadOnly) return
    const view = viewRef.current
    const m = menu
    setMenu(null)
    if (!view || !m) return
    try {
      const text = await api.invoke('clipboard:read', undefined)
      view.dispatch({
        changes: { from: m.from, to: m.to, insert: text },
        selection: { anchor: m.from + text.length }
      })
      view.focus()
    } catch (err) {
      toast.error(t('editor.pasteFail'))
    }
  }

  async function runAction(action: ChatAction): Promise<void> {
    if (isReadOnly) return
    const view = viewRef.current
    const m = menu
    setMenu(null)
    if (!view || !m || !docMeta) return
    const docLength = view.state.doc.length
    const hasSelection = !m.empty
    const anchor = hasSelection ? m.from : m.to
    let before = 200
    let after = 200
    if (action === 'plot') {
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
        title: t('sidebar.promptChatDefault'),
        docId,
        contextRange,
        action
      })
      await refresh()
      openChat(chat)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function exportDoc(format: 'md' | 'txt'): Promise<void> {
    const res = await api.invoke('export:doc', { docId, format })
    if (res.ok) toast.success(t('editor.exportOk', { path: res.path ?? '' }))
    else if (res.error !== '已取消') toast.error(res.error ?? t('editor.exportFail'))
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-1.5" style={{ background: 'var(--panel)', borderColor: 'var(--border)' }}>
        <span className="text-sm font-medium">{tab.title}</span>
        {isReadOnly && <span className="text-xs" style={{ color: 'var(--muted)' }}>{t('editor.readOnly')}</span>}
        {dirty && !isReadOnly && (
          <span className="text-xs" style={{ color: 'var(--warn)' }}>
            ● {t('editor.unsaved')}
          </span>
        )}
        <span className="flex-1" />
        <button className="btn !px-2 !py-1" onClick={() => setFontSize((f) => Math.max(12, f - 1))} title={t('editor.fontDown')}>
          <Minus size={14} />
        </button>
        <span className="w-8 text-center text-xs" style={{ color: 'var(--muted)' }}>
          {fontSize}
        </span>
        <button className="btn !px-2 !py-1" onClick={() => setFontSize((f) => Math.min(28, f + 1))} title={t('editor.fontUp')}>
          <Plus size={14} />
        </button>
        {!isReadOnly && (
          <>
            <button
              className="btn !px-2 !py-1"
              onClick={toggleCenteredParagraphs}
              title={t('editor.center')}
              aria-label={t('editor.center')}
              aria-pressed={centeredSelection}
            >
              <AlignCenter size={14} />
            </button>
            <button
              className="btn !px-2 !py-1"
              onClick={toggleFirstLineIndent}
              title={t('editor.firstLineIndent')}
              aria-label={t('editor.firstLineIndent')}
              aria-pressed={firstLineIndent}
            >
              <IndentIncrease size={14} />
            </button>
            <button className="btn !px-2 !py-1" onClick={() => void doSave().catch(() => undefined)} title={t('editor.save')}>
              <Save size={14} />
            </button>
          </>
        )}
        <button className="btn !px-2 !py-1" onClick={() => void exportDoc('md')} title={t('editor.exportMd')}>
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

      <div className="editor-statusbar" aria-live="polite">
        {t('editor.characters', {
          total: characterStats.total.toLocaleString(),
          nonWhitespace: characterStats.nonWhitespace.toLocaleString()
        })}
      </div>

      {menu && (
        <div
          ref={menuRef}
          className="fixed z-50 w-36 rounded-lg border py-1 shadow-xl"
          style={{ left: menuPos?.x ?? menu.x, top: menuPos?.y ?? menu.y, background: 'var(--panel2)', borderColor: 'var(--border)' }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {!menu.empty && (
            <>
              <button className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--panel3)]" onClick={() => void copySelection()}>
                <Copy size={13} />
                {t('editor.copy')}
              </button>
              {!isReadOnly && (
                <button className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--panel3)]" onClick={() => void cutSelection()}>
                  <Scissors size={13} />
                  {t('editor.cut')}
                </button>
              )}
            </>
          )}
          {!isReadOnly && (
            <>
              <button className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--panel3)]" onClick={() => void pasteAtCursor()}>
                <ClipboardPaste size={13} />
                {t('editor.paste')}
              </button>
              <div className="mx-2 my-1 border-t" style={{ borderColor: 'var(--border)' }} />
              {ACTIONS.filter((a) => a.value !== 'optimize' || !menu.empty).map((a) => {
                const Icon = a.icon
                return (
                  <button
                    key={a.value}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--panel3)]"
                    onClick={() => void runAction(a.value)}
                  >
                    <Icon size={13} />
                    {t(a.labelKey)}
                  </button>
                )
              })}
            </>
          )}
        </div>
      )}
    </div>
  )
}
