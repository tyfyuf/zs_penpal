import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import {
  Activity,
  Archive,
  ChevronDown,
  ChevronRight,
  Eye,
  FileText,
  FlaskConical,
  Folder,
  FolderOpen,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  Sparkles,
  Stethoscope,
  Trash2,
  TrendingUp,
  Upload,
  Wand2,
  X
} from 'lucide-react'
import type { ChatMeta, DocMeta, ProjectTree } from '@shared/types'
import { RESOURCE_FILE_ACCEPT, isSupportedResourceFile } from '@shared/resource-formats'
import { useAppStore } from '../../store/app.store'
import { api } from '../../lib/api'
import { toast } from '../../store/toast.store'
import { confirmDialog, promptText } from '../../store/dialog.store'
import { useT } from '../../i18n'
import { runDistill, runGenerateTitle } from '../../lib/summaryActions'
import { chatText, resourceText, storyText } from '../../lib/summaryPreview'
import type { ProjectSummariesOverview } from '@shared/types'
import SummaryArea from './SummaryArea'
import Modal from '../common/Modal'

const SIDEBAR_EXPANDED_STORAGE_KEY = 'vibewrite.sidebar.expanded'
const SIDEBAR_WIDTH_STORAGE_KEY = 'vibewrite.sidebar.width'
const DEFAULT_SIDEBAR_WIDTH = 260
const MIN_SIDEBAR_WIDTH = 220
const MAX_SIDEBAR_WIDTH = 480
const MAX_SIDEBAR_VIEWPORT_RATIO = 0.4

function getSidebarMaxWidth(viewportWidth: number): number {
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.floor(viewportWidth * MAX_SIDEBAR_VIEWPORT_RATIO)))
}

function clampSidebarWidth(width: number, viewportWidth: number): number {
  return Math.min(getSidebarMaxWidth(viewportWidth), Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)))
}

function readSidebarWidth(): number {
  try {
    const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY))
    if (Number.isFinite(stored)) return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(stored)))
  } catch {
    // Ignore storage failures and use the default width.
  }
  return DEFAULT_SIDEBAR_WIDTH
}

type SearchResultKind = 'doc' | 'chat' | 'resource' | 'summary'
type SummaryKind = 'doc' | 'chat' | 'resource'
type SearchResult = {
  key: string
  kind: SearchResultKind
  title: string
  projectName: string
  projectId: string
  parentTitle?: string
  summaryKind?: SummaryKind
  refId: string
  preview?: string
}

type SummaryPreview = { title: string; text: string }

function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function readSidebarExpanded(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(SIDEBAR_EXPANDED_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => typeof value === 'boolean')
    )
  } catch {
    return {}
  }
}

export default function Sidebar(): JSX.Element {
  const t = useT()
  const workspace = useAppStore((s) => s.workspace)
  const tabs = useAppStore((s) => s.tabs)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const refresh = useAppStore((s) => s.refreshWorkspace)
  const summaryRevision = useAppStore((s) => s.summaryRevision)
  const openDoc = useAppStore((s) => s.openDoc)
  const openChat = useAppStore((s) => s.openChat)
  const openSettings = useAppStore((s) => s.openSettings)
  const openResource = useAppStore((s) => s.openResource)
  const [expanded, setExpanded] = useState<Record<string, boolean>>(readSidebarExpanded)
  const [autoExpanded, setAutoExpanded] = useState<Record<string, boolean>>({})
  const sidebarRef = useRef<HTMLDivElement>(null)
  const resizeOriginLeftRef = useRef(0)
  const [preferredSidebarWidth, setPreferredSidebarWidth] = useState(readSidebarWidth)
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  const [isResizing, setIsResizing] = useState(false)
  const sidebarMaxWidth = getSidebarMaxWidth(viewportWidth)
  const sidebarWidth = clampSidebarWidth(preferredSidebarWidth, viewportWidth)
  const activeTab = tabs.find((tab) => tab.id === activeTabId)
  const activeDocId = activeTab?.kind === 'doc' ? activeTab.refId ?? null : null
  const activeChatId = activeTab?.kind === 'chat' ? activeTab.refId ?? null : null
  const activeDoc = activeDocId
    ? workspace.projects.flatMap((project) => project.docs).find((doc) => doc.id === activeDocId)
    : undefined
  const activeChat = activeChatId
    ? workspace.projects.flatMap((project) => project.chats).find((chat) => chat.id === activeChatId)
    : undefined
  const activeProjectId = activeTab?.projectId ?? activeDoc?.projectId ?? activeChat?.projectId
  const autoExpandedKeys = useMemo(() => {
    const keys = new Set<string>()
    if (!activeTab || !activeProjectId) return keys

    const projectKey = `p:${activeProjectId}`
    keys.add(projectKey)

    if (activeTab.kind === 'doc' && activeDocId) {
      keys.add(`${projectKey}:docs`)
    } else if (activeTab.kind === 'chat') {
      if (activeChat?.docId) {
        keys.add(`${projectKey}:docs`)
        keys.add(`${projectKey}:doc:${activeChat.docId}`)
      } else {
        keys.add(`${projectKey}:chats`)
      }
    }

    return keys
  }, [activeTab, activeDocId, activeProjectId, activeChat?.docId])

  useEffect(() => {
    const next = Object.fromEntries([...autoExpandedKeys].map((key) => [key, true]))
    setAutoExpanded(next)
  }, [autoExpandedKeys])

  useEffect(() => {
    let cancelled = false
    void Promise.all(
      workspace.projects.map(async (project) => {
        try {
          return [project.project.id, await api.invoke('summary:listProject', project.project.id)] as const
        } catch {
          return null
        }
      })
    ).then((entries) => {
      if (cancelled) return
      setSummaryOverviews(Object.fromEntries(entries.filter((entry): entry is readonly [string, ProjectSummariesOverview] => entry !== null)))
    })
    return () => {
      cancelled = true
    }
  }, [summaryRevision, workspace.projects])

  useEffect(() => {
    const off = api.on('summary:status', (payload) => {
      if (!payload.key.startsWith('res:')) return
      setSummaryGeneratingResources((current) => ({
        ...current,
        [payload.key.slice(4)]: payload.generating
      }))
    })
    return off
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_EXPANDED_STORAGE_KEY, JSON.stringify(expanded))
    } catch {
      // Ignore storage failures; collapsing remains functional for this session.
    }
  }, [expanded])

  useEffect(() => {
    const handleResize = (): void => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(preferredSidebarWidth))
    } catch {
      // Ignore storage failures; resizing remains functional for this session.
    }
  }, [preferredSidebarWidth])

  useEffect(() => {
    if (!isResizing) return

    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const handlePointerMove = (event: PointerEvent): void => {
      setPreferredSidebarWidth(clampSidebarWidth(event.clientX - resizeOriginLeftRef.current, window.innerWidth))
    }
    const stopResizing = (): void => setIsResizing(false)

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResizing)
    window.addEventListener('pointercancel', stopResizing)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopResizing)
      window.removeEventListener('pointercancel', stopResizing)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
    }
  }, [isResizing])

  const beginSidebarResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    resizeOriginLeftRef.current = sidebarRef.current?.getBoundingClientRect().left ?? 0
    event.preventDefault()
    setIsResizing(true)
  }

  const handleSidebarResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    let nextWidth: number | null = null
    const step = event.shiftKey ? 40 : 10
    if (event.key === 'ArrowLeft') nextWidth = sidebarWidth - step
    else if (event.key === 'ArrowRight') nextWidth = sidebarWidth + step
    else if (event.key === 'Home') nextWidth = MIN_SIDEBAR_WIDTH
    else if (event.key === 'End') nextWidth = sidebarMaxWidth
    if (nextWidth === null) return
    event.preventDefault()
    setPreferredSidebarWidth(clampSidebarWidth(nextWidth, viewportWidth))
  }
  const fileInput = useRef<HTMLInputElement>(null)
  const [uploadProject, setUploadProject] = useState<string | null>(null)
  const [previewRes, setPreviewRes] = useState<{ name: string; content: string } | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [summaryOverviews, setSummaryOverviews] = useState<Record<string, ProjectSummariesOverview>>({})
  const [summaryGeneratingResources, setSummaryGeneratingResources] = useState<Record<string, boolean>>({})
  const [summaryPreview, setSummaryPreview] = useState<SummaryPreview | null>(null)
  const isOpen = (key: string, defaultOpen = false): boolean => autoExpanded[key] ?? expanded[key] ?? defaultOpen
  const toggle = (key: string, defaultOpen = false): void => {
    setExpanded((e) => ({ ...e, [key]: !isOpen(key, defaultOpen) }))
    setAutoExpanded((e) => {
      if (!(key in e)) return e
      const next = { ...e }
      delete next[key]
      return next
    })
  }

  const normalizedQuery = normalizeSearchText(searchQuery)
  const searchResults = useMemo<SearchResult[]>(() => {
    if (!normalizedQuery) return []
    const results: SearchResult[] = []
    const matches = (...values: (string | undefined)[]): boolean => values.some((value) => value && normalizeSearchText(value).includes(normalizedQuery))
    for (const project of workspace.projects) {
      const projectId = project.project.id
      const projectName = project.project.name
      for (const doc of project.docs) {
        if (matches(doc.title, projectName)) results.push({ key: `doc:${doc.id}`, kind: 'doc', title: doc.title, projectName, projectId, refId: doc.id })
      }
      for (const chat of project.chats) {
        const parentTitle = chat.docId ? project.docs.find((doc) => doc.id === chat.docId)?.title : undefined
        if (matches(chat.title, parentTitle, projectName)) {
          results.push({ key: `chat:${chat.id}`, kind: 'chat', title: chat.title, projectName, projectId, parentTitle, refId: chat.id })
        }
      }
      for (const resource of project.resources) {
        if (matches(resource.name, projectName)) results.push({ key: `resource:${resource.id}`, kind: 'resource', title: resource.name, projectName, projectId, refId: resource.id })
      }
      const overview = summaryOverviews[projectId]
      if (!overview) continue
      for (const doc of overview.docs) {
        if (doc.hasSummary && matches(doc.title, projectName)) {
          results.push({ key: `summary:doc:${doc.docId}`, kind: 'summary', summaryKind: 'doc', title: doc.title, projectName, projectId, refId: doc.docId, preview: t('summary.previewDocTitle') })
        }
      }
      for (const chat of overview.chats) {
        if (chat.hasSummary && matches(chat.title, projectName)) {
          const parentTitle = chat.docId ? project.docs.find((doc) => doc.id === chat.docId)?.title : undefined
          results.push({ key: `summary:chat:${chat.chatId}`, kind: 'summary', summaryKind: 'chat', title: chat.title, projectName, projectId, parentTitle, refId: chat.chatId, preview: t('summary.previewChatTitle') })
        }
      }
      for (const resource of overview.resources) {
        if (resource.distilled && matches(resource.name, projectName)) {
          results.push({ key: `summary:resource:${resource.resourceId}`, kind: 'summary', summaryKind: 'resource', title: resource.name, projectName, projectId, refId: resource.resourceId, preview: t('summary.previewResTitle') })
        }
      }
    }
    return results
  }, [normalizedQuery, summaryOverviews, t, workspace.projects])

  function clearSearch(): void {
    setSearchQuery('')
  }

  function openSearchResult(result: SearchResult): void {
    clearSearch()
    if (result.kind === 'doc') {
      const doc = workspace.projects.find((project) => project.project.id === result.projectId)?.docs.find((item) => item.id === result.refId)
      if (doc) openDoc(doc)
      return
    }
    if (result.kind === 'chat') {
      const chat = workspace.projects.find((project) => project.project.id === result.projectId)?.chats.find((item) => item.id === result.refId)
      if (chat) openChat(chat)
      return
    }
    if (result.kind === 'resource') {
      const resource = workspace.projects.find((project) => project.project.id === result.projectId)?.resources.find((item) => item.id === result.refId)
      if (resource) openResource(result.projectId, resource.id, resource.name)
      return
    }
    void previewSearchSummary(result)
  }

  async function previewSearchSummary(result: SearchResult): Promise<void> {
    if (!result.summaryKind) return
    try {
      if (result.summaryKind === 'doc') {
        const summary = await api.invoke('summary:getDoc', result.refId)
        if (summary) setSummaryPreview({ title: `${result.title} - ${t('summary.previewDocTitle')}`, text: storyText(summary) })
        else toast.info(t('summary.noDocSummary'))
      } else if (result.summaryKind === 'chat') {
        const summary = await api.invoke('summary:getChat', result.refId)
        if (summary) setSummaryPreview({ title: `${result.title} - ${t('summary.previewChatTitle')}`, text: chatText(summary) })
        else toast.info(t('summary.noChatSummary'))
      } else {
        const summary = await api.invoke('summary:getResource', { projectId: result.projectId, resourceId: result.refId })
        if (summary) setSummaryPreview({ title: `${result.title} - ${t('summary.previewResTitle')}`, text: resourceText(summary) })
        else toast.info(t('summary.noResSummary'))
      }
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function promptName(label: string, def = ''): Promise<string | null> {
    return promptText(label, def)
  }

  async function createProject(): Promise<void> {
    const name = await promptName(t('sidebar.promptProject'))
    if (!name) return
    try {
      await api.invoke('project:create', { name })
      await refresh()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function createDoc(projectId: string): Promise<void> {
    const title = await promptName(t('sidebar.promptDoc'), t('sidebar.promptDocDefault'))
    if (!title) return
    try {
      const doc = await api.invoke('doc:create', { projectId, title })
      await refresh()
      openDoc(doc)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function createChat(projectId: string, docId?: string): Promise<void> {
    const title = await promptName(t('sidebar.promptChat'), t('sidebar.promptChatDefault'))
    if (!title) return
    try {
      const chat = await api.invoke('chat:create', { projectId, kind: docId ? 'doc' : 'project', title, docId })
      await refresh()
      openChat(chat)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function renameProject(projectId: string, current: string): Promise<void> {
    const name = await promptName(t('sidebar.renameProjectPrompt'), current)
    if (!name) return
    await api.invoke('project:rename', { projectId, name })
    await refresh()
  }

  async function deleteProject(projectId: string): Promise<void> {
    if (!(await confirmDialog(t('sidebar.confirmDeleteProject')))) return
    await api.invoke('project:delete', projectId)
    await refresh()
  }

  async function toggleProjectSummaryMaintenance(projectId: string, enabled: boolean): Promise<void> {
    try {
      await api.invoke('project:setSummaryAutoMaintenance', { projectId, enabled })
      await refresh()
      toast.success(t(enabled ? 'sidebar.summaryMaintenanceEnabled' : 'sidebar.summaryMaintenanceDisabled'))
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function renameDoc(doc: DocMeta): Promise<void> {
    const title = await promptName(t('sidebar.renameDocPrompt'), doc.title)
    if (!title) return
    await api.invoke('doc:rename', { docId: doc.id, title })
    await refresh()
  }

  async function deleteDoc(doc: DocMeta): Promise<void> {
    if (!(await confirmDialog(t('sidebar.confirmDeleteDoc')))) return
    await api.invoke('doc:delete', doc.id)
    await refresh()
  }

  async function deleteChat(chat: ChatMeta): Promise<void> {
    if (!(await confirmDialog(t('sidebar.confirmDeleteChat')))) return
    await api.invoke('chat:delete', chat.id)
    await refresh()
  }

  async function restoreChat(chat: ChatMeta): Promise<void> {
    await api.invoke('chat:restore', chat.id)
    await refresh()
  }

  async function purgeChat(chat: ChatMeta): Promise<void> {
    if (!(await confirmDialog(t('sidebar.confirmPurgeChat')))) return
    await api.invoke('chat:purge', chat.id)
    await refresh()
  }

  async function uploadResource(projectId: string): Promise<void> {
    setUploadProject(projectId)
    fileInput.current?.click()
  }

  async function onFilePicked(file: File): Promise<void> {
    const projectId = uploadProject
    setUploadProject(null)
    if (!projectId) return
    if (!isSupportedResourceFile(file.name)) {
      toast.error(t('sidebar.badExt'))
      return
    }
    const data = new Uint8Array(await file.arrayBuffer())
    try {
      await api.invoke('resource:upload', { projectId, name: file.name, data })
      await refresh()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  function isResourceGenerating(projectId: string, resourceId: string): boolean {
    const eventState = summaryGeneratingResources[resourceId]
    if (eventState !== undefined) return eventState
    return summaryOverviews[projectId]?.resources.some((resource) => resource.resourceId === resourceId && resource.generating) ?? false
  }

  async function deleteResource(projectId: string, resourceId: string): Promise<void> {
    if (isResourceGenerating(projectId, resourceId)) {
      toast.error(t('resource.distilling'))
      return
    }
    if (!(await confirmDialog(t('sidebar.confirmDeleteResource')))) return
    await api.invoke('resource:delete', { projectId, resourceId })
    await refresh()
  }

  async function restoreDoc(doc: DocMeta): Promise<void> {
    await api.invoke('doc:restore', doc.id)
    await refresh()
  }

  async function purgeDoc(doc: DocMeta): Promise<void> {
    if (!(await confirmDialog(t('sidebar.confirmPurgeDoc')))) return
    await api.invoke('doc:purge', doc.id)
    await refresh()
  }

  function renderDocChats(project: ProjectTree, doc: DocMeta): JSX.Element[] {
    const chats = project.chats.filter((c) => c.docId === doc.id)
    return chats.map((c) => {
      const isActive = activeChatId === c.id
      return (
        <div
          key={c.id}
          className="group flex items-center gap-1 border-l-2 py-0.5 pl-9 pr-1 text-[13px] hover:bg-[var(--panel3)]"
          style={{
            background: isActive ? 'var(--accent-soft)' : undefined,
            borderLeftColor: isActive ? 'var(--accent)' : 'transparent'
          }}
          aria-current={isActive ? 'page' : undefined}
        >
          <MessageSquare size={13} style={{ color: isActive ? 'var(--accent)' : 'var(--muted)' }} />
          <span className="min-w-0 flex-1 cursor-pointer truncate" onClick={() => openChat(c)} title={c.title}>
            {c.title}
          </span>
          <ActionBadge chat={c} />
          {project.project.system !== 'feature-guide' && (
            <div className="hidden gap-0.5 group-hover:flex">
              <TitleButton chatId={c.id} />
              <IconButton icon={<Trash2 size={12} />} title={t('sidebar.delete')} onClick={() => void deleteChat(c)} />
            </div>
          )}
        </div>
      )
    })
  }

  return (
    <div
      ref={sidebarRef}
      className="relative flex shrink-0 flex-col border-r"
      style={{ width: sidebarWidth, background: 'var(--panel)', borderColor: 'var(--border)' }}
    >
      <input
        ref={fileInput}
        type="file"
        accept={RESOURCE_FILE_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void onFilePicked(f)
          e.target.value = ''
        }}
      />

      <div className="flex items-center justify-between border-b px-3 py-2" style={{ borderColor: 'var(--border)' }}>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{t('app.title')}</div>
          <div className="truncate text-[11px]" style={{ color: 'var(--muted)' }} title={workspace.workspaceDir}>
            {workspace.workspaceDir || '未设置工作目录'}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <IconButton icon={<Plus size={15} />} title={t('sidebar.newProject')} onClick={() => void createProject()} />
          <IconButton icon={<Settings size={15} />} title={t('sidebar.settings')} onClick={openSettings} />
        </div>
      </div>

      <div className="border-b px-2 py-1.5" style={{ borderColor: 'var(--border)' }}>
        <div
          className="flex items-center gap-1 rounded border px-2 py-1"
          style={{ background: 'var(--panel2)', borderColor: 'var(--border)' }}
        >
          <Search size={14} style={{ color: 'var(--muted)' }} />
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') clearSearch()
            }}
            placeholder={t('sidebar.searchPlaceholder')}
            aria-label={t('sidebar.searchPlaceholder')}
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-[var(--muted)]"
          />
          {searchQuery && (
            <button
              type="button"
              className="rounded p-0.5 hover:opacity-70"
              style={{ color: 'var(--muted)' }}
              onClick={clearSearch}
              aria-label={t('sidebar.clearSearch')}
              title={t('sidebar.clearSearch')}
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {normalizedQuery ? (
          <div className="px-2">
            <div className="px-1 pb-1 text-[11px]" style={{ color: 'var(--muted)' }}>
              {t('sidebar.searchResults', { count: searchResults.length })}
            </div>
            {searchResults.length === 0 ? (
              <div className="px-1 py-6 text-center text-xs" style={{ color: 'var(--muted)' }}>
                {t('sidebar.searchNoResults')}
              </div>
            ) : (
              (['doc', 'chat', 'resource', 'summary'] as SearchResultKind[]).map((kind) => {
                const results = searchResults.filter((result) => result.kind === kind)
                if (results.length === 0) return null
                const label =
                  kind === 'doc'
                    ? t('sidebar.searchDocs')
                    : kind === 'chat'
                      ? t('sidebar.searchChats')
                      : kind === 'resource'
                        ? t('sidebar.searchResources')
                        : t('sidebar.searchSummaries')
                return (
                  <section key={kind} className="mb-2">
                    <div className="px-1 py-0.5 text-[11px] font-medium" style={{ color: 'var(--muted)' }}>
                      {label}
                    </div>
                    <div className="space-y-0.5">
                      {results.map((result) => {
                        const isActive =
                          (result.kind === 'doc' && activeDocId === result.refId) ||
                          (result.kind === 'chat' && activeChatId === result.refId)
                        const resultLabel = result.parentTitle ? `${result.projectName} / ${result.parentTitle}` : result.projectName
                        const suffix = result.kind === 'summary' ? ` - ${result.preview}` : ''
                        return (
                          <button
                            key={result.key}
                            type="button"
                            className="flex w-full items-start gap-1 border-l-2 px-1.5 py-1 text-left text-[12px] hover:bg-[var(--panel3)]"
                            style={{
                              background: isActive ? 'var(--accent-soft)' : undefined,
                              borderLeftColor: isActive ? 'var(--accent)' : 'transparent'
                            }}
                            aria-current={isActive ? 'page' : undefined}
                            onClick={() => openSearchResult(result)}
                            title={`${resultLabel}${suffix}`}
                          >
                            {result.kind === 'doc' ? (
                              <FileText size={13} className="mt-0.5 shrink-0" style={{ color: isActive ? 'var(--accent)' : 'var(--muted)' }} />
                            ) : result.kind === 'chat' ? (
                              <MessageSquare size={13} className="mt-0.5 shrink-0" style={{ color: isActive ? 'var(--accent)' : 'var(--muted)' }} />
                            ) : result.kind === 'resource' ? (
                              <FileText size={13} className="mt-0.5 shrink-0" style={{ color: 'var(--muted)' }} />
                            ) : (
                              <Sparkles size={13} className="mt-0.5 shrink-0" style={{ color: 'var(--accent)' }} />
                            )}
                            <span className="min-w-0 flex-1">
                              <span className="block truncate" style={{ color: isActive ? 'var(--text)' : 'var(--text)' }}>
                                {result.title}
                              </span>
                              <span className="block truncate text-[10px]" style={{ color: 'var(--muted)' }}>
                                {resultLabel}{suffix}
                              </span>
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </section>
                )
              })
            )}
          </div>
        ) : (
          <>
        {workspace.projects.length === 0 && (
          <div className="px-3 py-6 text-center text-xs" style={{ color: 'var(--muted)' }}>
            {t('sidebar.empty')}
          </div>
        )}

        {workspace.projects.map((p) => {
          const projectKey = `p:${p.project.id}`
          const projectChats = p.chats.filter((c) => !c.docId)
          const isFeatureGuide = p.project.system === 'feature-guide'
          const open = isOpen(projectKey, isFeatureGuide)
          return (
            <div key={p.project.id} className="mb-0.5">
              <div className="group flex items-center gap-1 px-2 py-1.5 hover:bg-[var(--panel3)]">
                <button className="flex items-center gap-1" onClick={() => toggle(projectKey, isFeatureGuide)}>
                  {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  {open ? <FolderOpen size={15} style={{ color: 'var(--accent)' }} /> : <Folder size={15} style={{ color: 'var(--accent)' }} />}
                </button>
                <span className="min-w-0 flex-1 truncate text-sm font-medium" title={p.project.name}>
                  {p.project.name}
                </span>
                {!isFeatureGuide && <IconButton
                  icon={<Activity size={12} />}
                  title={t(p.project.summaryAutoMaintenance ? 'sidebar.disableSummaryMaintenance' : 'sidebar.enableSummaryMaintenance')}
                  onClick={() => void toggleProjectSummaryMaintenance(p.project.id, !p.project.summaryAutoMaintenance)}
                  active={p.project.summaryAutoMaintenance === true}
                />}
                <div className="hidden gap-0.5 group-hover:flex">
                  {!isFeatureGuide && <>
                    <IconButton icon={<FileText size={12} />} title={t('sidebar.newDoc')} onClick={() => void createDoc(p.project.id)} />
                    <IconButton icon={<MessageSquare size={12} />} title={t('sidebar.newProjChat')} onClick={() => void createChat(p.project.id)} />
                    <IconButton icon={<MoreHorizontal size={12} />} title={t('sidebar.rename')} onClick={() => void renameProject(p.project.id, p.project.name)} />
                  </>}
                  <IconButton icon={<Trash2 size={12} />} title={t('sidebar.deleteProject')} onClick={() => void deleteProject(p.project.id)} />
                </div>
              </div>

              {open && (
                <div>
                  <Section
                    label={t('sidebar.secDocs')}
                    open={isOpen(`${projectKey}:docs`, isFeatureGuide)}
                    onToggle={() => toggle(`${projectKey}:docs`, isFeatureGuide)}
                    onAdd={isFeatureGuide ? undefined : () => void createDoc(p.project.id)}
                  >
                    {isOpen(`${projectKey}:docs`, isFeatureGuide) &&
                      p.docs.map((doc) => {
                        const docChats = p.chats.filter((chat) => chat.docId === doc.id)
                        const docChatsKey = `${projectKey}:doc:${doc.id}`
                        const docChatsOpen = isOpen(docChatsKey, true)
                        const isActive = activeDocId === doc.id
                        const isActiveParent = !isActive && activeChatId !== null && activeChat?.docId === doc.id
                        return (
                          <div key={doc.id}>
                            <div
                              className="group flex items-center gap-1 border-l-2 py-0.5 pl-6 pr-1 text-[13px] hover:bg-[var(--panel3)]"
                              style={{
                                background: isActive ? 'var(--accent-soft)' : undefined,
                                borderLeftColor: isActive || isActiveParent ? 'var(--accent)' : 'transparent'
                              }}
                              aria-current={isActive ? 'page' : undefined}
                            >
                              <FileText size={13} style={{ color: isActive ? 'var(--accent)' : 'var(--muted)' }} />
                              {docChats.length > 0 && (
                                <button
                                  type="button"
                                  className="shrink-0 rounded p-0.5 hover:opacity-70"
                                  style={{ color: 'var(--muted)' }}
                                  title={docChatsOpen ? t('sidebar.collapseDocChats') : t('sidebar.expandDocChats')}
                                  aria-label={docChatsOpen ? t('sidebar.collapseDocChats') : t('sidebar.expandDocChats')}
                                  aria-expanded={docChatsOpen}
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    toggle(docChatsKey, true)
                                  }}
                                >
                                  {docChatsOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                                </button>
                              )}
                              <span
                                className="min-w-0 flex-1 cursor-pointer truncate"
                                onClick={() => openDoc(doc)}
                                title={doc.title}
                              >
                                {doc.title}
                              </span>
                              {!isFeatureGuide && <div className="hidden gap-0.5 group-hover:flex">
                                <IconButton icon={<MessageSquare size={12} />} title={t('sidebar.newDocChat')} onClick={() => void createChat(p.project.id, doc.id)} />
                                <IconButton icon={<MoreHorizontal size={12} />} title={t('sidebar.rename')} onClick={() => void renameDoc(doc)} />
                                <IconButton icon={<Trash2 size={12} />} title={t('sidebar.delete')} onClick={() => void deleteDoc(doc)} />
                              </div>}
                            </div>
                            {docChatsOpen && renderDocChats(p, doc)}
                          </div>
                        )
                      })}
                  </Section>

                  <Section
                    label={t('sidebar.secChats')}
                    open={isOpen(`${projectKey}:chats`, isFeatureGuide)}
                    onToggle={() => toggle(`${projectKey}:chats`, isFeatureGuide)}
                    onAdd={isFeatureGuide ? undefined : () => void createChat(p.project.id)}
                  >
                    {isOpen(`${projectKey}:chats`, isFeatureGuide) &&
                      projectChats.map((c) => {
                        const isActive = activeChatId === c.id
                        return (
                          <div
                            key={c.id}
                            className="group flex items-center gap-1 border-l-2 py-0.5 pl-6 pr-1 text-[13px] hover:bg-[var(--panel3)]"
                            style={{
                              background: isActive ? 'var(--accent-soft)' : undefined,
                              borderLeftColor: isActive ? 'var(--accent)' : 'transparent'
                            }}
                            aria-current={isActive ? 'page' : undefined}
                          >
                            <MessageSquare size={13} style={{ color: isActive ? 'var(--accent)' : 'var(--muted)' }} />
                            <span className="min-w-0 flex-1 cursor-pointer truncate" onClick={() => openChat(c)} title={c.title}>
                              {c.title}
                            </span>
                            {!isFeatureGuide && (
                              <div className="hidden gap-0.5 group-hover:flex">
                                <TitleButton chatId={c.id} />
                                <IconButton icon={<Trash2 size={12} />} title={t('sidebar.delete')} onClick={() => void deleteChat(c)} />
                              </div>
                            )}
                          </div>
                        )
                      })}
                  </Section>

                  {!isFeatureGuide && <Section label={t('sidebar.secResources')} open={isOpen(`${projectKey}:res`)} onToggle={() => toggle(`${projectKey}:res`)} onAdd={() => void uploadResource(p.project.id)}>
                    {isOpen(`${projectKey}:res`) &&
                      p.resources.map((r) => {
                        const generating = isResourceGenerating(p.project.id, r.id)
                        return (
                        <div key={r.id} className="group flex items-center gap-1 py-0.5 pl-6 pr-1 text-[13px] hover:bg-[var(--panel3)]">
                          <FileText size={13} style={{ color: 'var(--muted)' }} />
                          <span className="min-w-0 flex-1 cursor-pointer truncate" onClick={() => openResource(p.project.id, r.id, r.name)} title={r.name}>
                            {r.name}
                          </span>
                          <div className="hidden gap-0.5 group-hover:flex">
                            <IconButton
                              icon={<Eye size={12} />}
                              title={t('sidebar.preview')}
                              onClick={async () => {
                                try {
                                  const res = await api.invoke('resource:read', { projectId: p.project.id, resourceId: r.id })
                                  setPreviewRes({ name: res.name, content: res.content })
                                } catch (err) {
                                  toast.error((err as Error).message)
                                }
                              }}
                            />
                            <IconButton icon={<FlaskConical size={12} />} title={generating ? t('resource.distilling') : t('sidebar.distill')} disabled={generating} onClick={() => void runDistill(p.project.id, r.id)} />
                            <IconButton icon={<Trash2 size={12} />} title={generating ? t('resource.distilling') : t('sidebar.delete')} disabled={generating} onClick={() => void deleteResource(p.project.id, r.id)} />
                          </div>
                        </div>
                        )
                      })}
                  </Section>}

                  {!isFeatureGuide && <Section label={t('sidebar.secSummary')} open={isOpen(`${projectKey}:summary`)} onToggle={() => toggle(`${projectKey}:summary`)}>
                    {isOpen(`${projectKey}:summary`) && <SummaryArea projectId={p.project.id} />}
                  </Section>}
                </div>
              )}
            </div>
          )
        })}
          </>
        )}
      </div>

      {summaryPreview && (
        <Modal
          title={summaryPreview.title}
          onClose={() => setSummaryPreview(null)}
          footer={
            <button className="btn" onClick={() => setSummaryPreview(null)}>
              {t('upload.close')}
            </button>
          }
        >
          <pre className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed">{summaryPreview.text}</pre>
        </Modal>
      )}

      {previewRes && (
        <Modal
          title={previewRes.name}
          onClose={() => setPreviewRes(null)}
          footer={
            <button className="btn" onClick={() => setPreviewRes(null)}>
              {t('upload.close')}
            </button>
          }
        >
          <pre className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap font-mono text-xs leading-relaxed">
            {previewRes.content}
          </pre>
        </Modal>
      )}

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('sidebar.resize')}
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={sidebarMaxWidth}
        aria-valuenow={sidebarWidth}
        tabIndex={0}
        title={t('sidebar.resizeResetHint')}
        className="group absolute -right-[3px] top-0 z-40 h-full w-[6px] cursor-col-resize outline-none"
        style={{ touchAction: 'none' }}
        onPointerDown={beginSidebarResize}
        onDoubleClick={() => setPreferredSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
        onKeyDown={handleSidebarResizeKeyDown}
      >
        <span
          className={`absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-[var(--accent)] transition-opacity ${
            isResizing ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus:opacity-100'
          }`}
        />
      </div>
    </div>
  )
}

function IconButton({ icon, title, onClick, disabled, active = false }: { icon: JSX.Element; title: string; onClick: () => void; disabled?: boolean; active?: boolean }): JSX.Element {
  return (
    <button
      className="rounded p-0.5 hover:opacity-70 disabled:opacity-40 disabled:hover:opacity-40"
      style={{ color: active ? 'var(--accent)' : 'var(--muted)', background: active ? 'var(--accent-soft)' : undefined }}
      title={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      {icon}
    </button>
  )
}

function Section({
  label,
  open,
  onToggle,
  onAdd,
  children
}: {
  label: string
  open: boolean
  onToggle: () => void
  onAdd?: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <div className="mb-0.5">
      <div className="group flex items-center gap-1 px-2 py-0.5 text-[12px] hover:bg-[var(--panel3)]" style={{ color: 'var(--muted)' }}>
        <button className="flex items-center gap-0.5" onClick={onToggle}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span className="font-medium">{label}</span>
        </button>
        <span className="flex-1" />
        {onAdd && (
          <button className="hidden rounded p-0.5 group-hover:block hover:opacity-70" onClick={onAdd} title={`新建${label}`}>
            <Plus size={12} />
          </button>
        )}
      </div>
      {children}
    </div>
  )
}

function TitleButton({ chatId }: { chatId: string }): JSX.Element {
  const t = useT()
  const streaming = useAppStore((s) => s.streamingChats[chatId])
  const generating = useAppStore((s) => s.titleGenerating[chatId])
  return (
    <IconButton
      icon={<Sparkles size={12} />}
      title={generating ? t('sidebar.genTitleBusy') : t('sidebar.genTitle')}
      disabled={!!streaming || !!generating}
      onClick={() => void runGenerateTitle(chatId)}
    />
  )
}

function ActionBadge({ chat }: { chat: ChatMeta }): JSX.Element | null {
  const t = useT()
  if (!chat.action) return null
  const label =
    chat.action === 'diagnose' ? t('sidebar.actionDiagnose') : chat.action === 'plot' ? t('sidebar.actionPlot') : t('sidebar.actionOptimize')
  const icon =
    chat.action === 'diagnose' ? <Stethoscope size={11} /> : chat.action === 'plot' ? <TrendingUp size={11} /> : <Wand2 size={11} />
  return (
    <span className="inline-flex rounded px-1 py-0.5" style={{ color: 'var(--accent)' }} title={label}>
      {icon}
    </span>
  )
}
