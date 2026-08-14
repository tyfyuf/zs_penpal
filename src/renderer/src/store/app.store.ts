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
}

export const useAppStore = create<AppStore>((set, get) => ({
  config: null,
  workspace: { workspaceDir: '', projects: [], trashedProjects: [] },
  tabs: [],
  activeTabId: null,
  dirty: {},
  theme: (localStorage.getItem('theme') as 'dark' | 'light') ?? 'dark',
  initialized: false,

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
    set({ workspace })
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
  }
}))
