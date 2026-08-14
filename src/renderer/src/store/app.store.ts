import { create } from 'zustand'
import type { AppConfig, ChatMeta, ContextRange, DocMeta, WorkspaceSnapshot } from '@shared/types'
import { api } from '../lib/api'

export type TabKind = 'doc' | 'chat' | 'settings' | 'resource'

export interface Tab {
  id: string
  kind: TabKind
  title: string
  refId?: string
  projectId?: string
  chatKind?: 'project' | 'doc' | 'context'
  contextRange?: ContextRange
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
  closeTab(tabId: string): void
  activateTab(tabId: string): void
  setDirty(docId: string, v: boolean): void
  renameTab(tabId: string, title: string): void
  setContextRange(tabId: string, range: ContextRange): void
  setStreamingChat(chatId: string, v: boolean): void
  setTitleGenerating(chatId: string, v: boolean): void
  bumpSummary(): void
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
    const config = await api.invoke('config:get', undefined)
    const workspace = await api.invoke('workspace:get', undefined)
    const theme = get().theme
    document.documentElement.classList.toggle('light', theme === 'light')
    document.documentElement.classList.toggle('dark', theme === 'dark')
    set({ config, workspace, initialized: true })
  },

  setTheme(t) {
    localStorage.setItem('theme', t)
    document.documentElement.classList.toggle('light', t === 'light')
    document.documentElement.classList.toggle('dark', t === 'dark')
    set({ theme: t })
  },

  async refreshWorkspace() {
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

    // 清理已删除文档的脏标记
    const dirty = { ...get().dirty }
    for (const id of Object.keys(dirty)) {
      if (!normalDocIds.has(id)) delete dirty[id]
    }

    set({ workspace, tabs, activeTabId, dirty })
  },

  async updateConfig(patch) {
    const config = await api.invoke('config:set', patch)
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
      chatKind: chat.kind,
      contextRange: chat.contextRange
    }
    set({ tabs: [...tabs, tab], activeTabId: tab.id })
    void api.invoke('recovery:update', { projectId: chat.projectId, chatId: chat.id, timestamp: new Date().toISOString() })
  },

  openSettings() {
    const { tabs } = get()
    const existing = tabs.find((t) => t.kind === 'settings')
    if (existing) {
      set({ activeTabId: existing.id })
      return
    }
    const tab: Tab = { id: 'settings', kind: 'settings', title: '设置' }
    set({ tabs: [...tabs, tab], activeTabId: tab.id })
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

  closeTab(tabId) {
    const { tabs, activeTabId } = get()
    const idx = tabs.findIndex((t) => t.id === tabId)
    if (idx < 0) return
    const next = tabs.filter((t) => t.id !== tabId)
    let nextActive = activeTabId
    if (activeTabId === tabId) {
      nextActive = next[Math.min(idx, next.length - 1)]?.id ?? null
    }
    set({ tabs: next, activeTabId: nextActive })
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
