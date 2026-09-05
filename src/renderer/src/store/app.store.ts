import { create } from 'zustand'
import type { AppConfig, ChatAction, ChatMeta, ContextRange, DocMeta, ExternalFileResult, ResourceMeta, WorkspaceSnapshot } from '@shared/types'
import type { WorkspaceChangedPayload } from '@shared/ipc'
import { api } from '../lib/api'
import { useI18nStore } from '../i18n'

export type TabKind = 'doc' | 'chat' | 'resource' | 'external-resource'

export interface Tab {
  id: string
  kind: TabKind
  title: string
  refId?: string
  projectId?: string
  chatKind?: 'project' | 'doc' | 'context'
  contextRange?: ContextRange
  action?: ChatAction
  externalFile?: Required<Pick<ExternalFileResult, 'name' | 'path' | 'content' | 'data'>> &
    Pick<ExternalFileResult, 'sourceFormat' | 'contentFormat' | 'warnings'>
}

interface AppStore {
  config: AppConfig | null
  workspace: WorkspaceSnapshot
  tabs: Tab[]
  activeTabId: string | null
  dirty: Record<string, boolean>
  theme: 'dark' | 'light'
  initialized: boolean
  /** 正在流式输出的对话 */
  streamingChats: Record<string, boolean>
  /** 正在自动生成标题的对话 */
  titleGenerating: Record<string, boolean>
  /** 摘要系统版本号：任何摘要变更 +1，供摘要区刷新 */
  summaryRevision: number

  init(): Promise<void>
  setTheme(t: 'dark' | 'light'): void
  refreshWorkspace(): Promise<void>
  updateConfig(patch: Partial<AppConfig>): Promise<void>
  openDoc(doc: DocMeta): void
  openChat(chat: ChatMeta): void
  openSettings(): void
  openResource(projectId: string, resourceId: string, name: string): void
  openExternalResource(file: ExternalFileResult): void
  promoteExternalResource(tabId: string, resource: ResourceMeta): void
  closeTab(tabId: string): void
  activateTab(tabId: string): void
  setDirty(docId: string, v: boolean): void
  renameTab(tabId: string, title: string): void
  setContextRange(tabId: string, range: ContextRange): void
  setStreamingChat(chatId: string, v: boolean): void
  setTitleGenerating(chatId: string, v: boolean): void
  bumpSummary(): void
}

let configSub: (() => void) | null = null
let configChangeVersion = 0
let workspaceChangeSub: (() => void) | null = null
let workspacePollTimer: ReturnType<typeof setInterval> | null = null
let workspaceRefreshTimer: ReturnType<typeof setTimeout> | null = null
let workspaceRefreshInFlight: Promise<void> | null = null
let workspaceRefreshPending = false

function isSummaryChange(payload: WorkspaceChangedPayload): boolean {
  return payload.entityType === 'summary' || payload.reason.startsWith('summary-')
}

function scheduleWorkspaceRefresh(delay = 180): void {
  if (workspaceRefreshInFlight || workspaceRefreshTimer) {
    workspaceRefreshPending = true
    return
  }
  workspaceRefreshTimer = setTimeout(() => {
    workspaceRefreshTimer = null
    workspaceRefreshPending = false
    void useAppStore.getState().refreshWorkspace().catch(() => {})
  }, delay)
}

export const useAppStore = create<AppStore>((set, get) => ({
  config: null,
  workspace: { workspaceDir: '', projects: [], trashedProjects: [] },
  tabs: [],
  activeTabId: null,
  dirty: {},
  theme: (localStorage.getItem('theme') as 'dark' | 'light') ?? 'dark',
  initialized: false,
  streamingChats: {},
  titleGenerating: {},
  summaryRevision: 0,

  async init() {
    if (!configSub) {
      configSub = api.on('config:changed', (cfg) => {
        configChangeVersion += 1
        useI18nStore.getState().setLocale(cfg.language ?? 'zh')
        set({ config: cfg })
      })
    }
    const configVersionAtStart = configChangeVersion
    const config = await api.invoke('config:get', undefined)
    const workspace = await api.invoke('workspace:get', undefined)
    // A config event may arrive while workspace initialization is in flight.
    // Prefer the event-updated store value so a stale config response cannot
    // switch the renderer back to the previous language.
    const effectiveConfig = configChangeVersion === configVersionAtStart ? config : (get().config ?? config)
    const theme = get().theme
    document.documentElement.classList.toggle('light', theme === 'light')
    document.documentElement.classList.toggle('dark', theme === 'dark')
    useI18nStore.getState().setLocale(effectiveConfig.language ?? 'zh')
    // Keep the config cache in sync with main-process changes.
    if (workspaceChangeSub) workspaceChangeSub()
    workspaceChangeSub = api.on('workspace:changed', (payload) => {
      if (isSummaryChange(payload)) {
        set((state) => ({ summaryRevision: state.summaryRevision + 1 }))
        return
      }
      scheduleWorkspaceRefresh()
    })
    if (!workspacePollTimer) {
      workspacePollTimer = setInterval(() => {
        if (document.visibilityState === 'visible') scheduleWorkspaceRefresh(0)
      }, 20000)
    }
    set({ config: effectiveConfig, workspace, initialized: true })
  },

  setTheme(t) {
    localStorage.setItem('theme', t)
    document.documentElement.classList.toggle('light', t === 'light')
    document.documentElement.classList.toggle('dark', t === 'dark')
    set({ theme: t })
  },

  async refreshWorkspace() {
    if (workspaceRefreshInFlight) return workspaceRefreshInFlight
    workspaceRefreshInFlight = (async () => {
      const workspace = await api.invoke('workspace:get', undefined)

      // 关闭已被删除/归档/彻底删除的对象对应的标签页（PRD 改进：删除时关闭已打开标签）
      const normalDocIds = new Set(workspace.projects.flatMap((p) => p.docs.map((d) => d.id)))
      const normalChatIds = new Set(workspace.projects.flatMap((p) => p.chats.map((c) => c.id)))
      const normalResourceIds = new Set(workspace.projects.flatMap((p) => p.resources.map((r) => r.id)))

      const tabs = get().tabs.filter((t) => {
        if (t.kind === 'doc' && t.refId) return normalDocIds.has(t.refId)
        if (t.kind === 'chat' && t.refId) return normalChatIds.has(t.refId)
        if (t.kind === 'resource' && t.refId) return normalResourceIds.has(t.refId)
        return true // settings 标签保留
      })

      let activeTabId = get().activeTabId
      if (activeTabId && !tabs.some((t) => t.id === activeTabId)) {
        activeTabId = tabs[tabs.length - 1]?.id ?? null
      }

      // 清理已删除文档/资源的脏标记；外部临时标签使用标签 id 保留。
      const dirty = { ...get().dirty }
      const externalTabIds = new Set(tabs.filter((tab) => tab.kind === 'external-resource').map((tab) => tab.id))
      for (const id of Object.keys(dirty)) {
        if (!normalDocIds.has(id) && !normalResourceIds.has(id) && !externalTabIds.has(id)) delete dirty[id]
      }

      set({ workspace, tabs, activeTabId, dirty })
    })()
    try {
      await workspaceRefreshInFlight
    } finally {
      workspaceRefreshInFlight = null
      if (workspaceRefreshPending) {
        workspaceRefreshPending = false
        scheduleWorkspaceRefresh()
      }
    }
  },

  async updateConfig(patch) {
    const config = await api.invoke('config:set', patch)
    if (patch.language !== undefined) useI18nStore.getState().setLocale(config.language ?? 'zh')
    set({ config })
  },

  openDoc(doc) {
    const { tabs } = get()
    const existing = tabs.find((t) => t.kind === 'doc' && t.refId === doc.id)
    if (existing) {
      set({ activeTabId: existing.id })
      return
    }
    const tab: Tab = { id: `doc:${doc.id}`, kind: 'doc', title: doc.title, refId: doc.id }
    set({ tabs: [...tabs, tab], activeTabId: tab.id })
    void api.invoke('recovery:update', { projectId: doc.projectId, docId: doc.id, timestamp: new Date().toISOString() })
  },

  openChat(chat) {
    const { tabs } = get()
    const existing = tabs.find((t) => t.kind === 'chat' && t.refId === chat.id)
    if (existing) {
      set({ activeTabId: existing.id })
      return
    }
    const tab: Tab = {
      id: `chat:${chat.id}`,
      kind: 'chat',
      title: chat.title,
      refId: chat.id,
      projectId: chat.projectId,
      chatKind: chat.kind,
      contextRange: chat.contextRange,
      action: chat.action
    }
    set({ tabs: [...tabs, tab], activeTabId: tab.id })
    void api.invoke('recovery:update', { projectId: chat.projectId, chatId: chat.id, timestamp: new Date().toISOString() })
  },

  openSettings() {
    void api.invoke('settings:open', undefined)
  },

  openResource(projectId, resourceId, name) {
    const { tabs } = get()
    const existing = tabs.find((t) => t.kind === 'resource' && t.refId === resourceId)
    if (existing) {
      set({ activeTabId: existing.id })
      return
    }
    const tab: Tab = { id: `resource:${resourceId}`, kind: 'resource', title: name, refId: resourceId, projectId }
    set({ tabs: [...tabs, tab], activeTabId: tab.id })
  },

  openExternalResource(file) {
    if (!file.ok || !file.name || !file.path || file.content === undefined || !file.data) return
    const { tabs } = get()
    const existing = tabs.find((tab) => tab.kind === 'external-resource' && tab.externalFile?.path === file.path)
    if (existing) {
      set({ activeTabId: existing.id })
      return
    }
    const tab: Tab = {
      id: `external-resource:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      kind: 'external-resource',
      title: file.name,
      externalFile: {
        name: file.name,
        path: file.path,
        content: file.content,
        data: file.data,
        sourceFormat: file.sourceFormat,
        contentFormat: file.contentFormat,
        warnings: file.warnings
      }
    }
    set({ tabs: [...tabs, tab], activeTabId: tab.id })
  },

  promoteExternalResource(tabId, resource) {
    const canonicalId = `resource:${resource.id}`
    const nextId = canonicalId
    const tabs = get().tabs
      .filter((tab) => tab.id === tabId || !(tab.kind === 'resource' && tab.refId === resource.id))
      .map((tab) =>
        tab.id === tabId
          ? { id: nextId, kind: 'resource' as const, title: resource.name, refId: resource.id, projectId: resource.projectId }
          : tab
      )
    const dirty = { ...get().dirty }
    delete dirty[tabId]
    delete dirty[resource.id]
    set({ tabs, activeTabId: nextId, dirty })
  },

  closeTab(tabId) {
    const { tabs, activeTabId } = get()
    const idx = tabs.findIndex((t) => t.id === tabId)
    if (idx < 0) return
    const next = tabs.filter((t) => t.id !== tabId)
    let nextActive = activeTabId
    if (activeTabId === tabId) {
      nextActive = next[Math.min(idx, next.length - 1)]?.id ?? null
    }
    const dirty = { ...get().dirty }
    const closing = tabs[idx]
    const dirtyKey = closing.kind === 'external-resource' ? closing.id : closing.refId
    if (dirtyKey) delete dirty[dirtyKey]
    set({ tabs: next, activeTabId: nextActive, dirty })
  },

  activateTab(tabId) {
    set({ activeTabId: tabId })
  },

  setDirty(docId, v) {
    set({ dirty: { ...get().dirty, [docId]: v } })
  },

  renameTab(tabId, title) {
    set({ tabs: get().tabs.map((t) => (t.id === tabId ? { ...t, title } : t)) })
  },

  setContextRange(tabId, range) {
    set({ tabs: get().tabs.map((t) => (t.id === tabId ? { ...t, contextRange: range } : t)) })
  },

  setStreamingChat(chatId, v) {
    set({ streamingChats: { ...get().streamingChats, [chatId]: v } })
  },

  setTitleGenerating(chatId, v) {
    set({ titleGenerating: { ...get().titleGenerating, [chatId]: v } })
  },

  bumpSummary() {
    set({ summaryRevision: get().summaryRevision + 1 })
  }
}))
