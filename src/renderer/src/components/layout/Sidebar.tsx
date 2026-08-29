import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
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
  Settings,
  Sparkles,
  Stethoscope,
  Trash2,
  TrendingUp,
  Upload,
  Wand2
} from 'lucide-react'
import type { ChatMeta, DocMeta, ProjectTree } from '@shared/types'
import { useAppStore } from '../../store/app.store'
import { api } from '../../lib/api'
import { toast } from '../../store/toast.store'
import { confirmDialog, promptText } from '../../store/dialog.store'
import { useT } from '../../i18n'
import { runDistill, runGenerateTitle } from '../../lib/summaryActions'
import SummaryArea from './SummaryArea'
import Modal from '../common/Modal'

const ALLOWED_EXT = ['.txt', '.md', '.csv']
const SIDEBAR_EXPANDED_STORAGE_KEY = 'vibewrite.sidebar.expanded'

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
  const refresh = useAppStore((s) => s.refreshWorkspace)
  const openDoc = useAppStore((s) => s.openDoc)
  const openChat = useAppStore((s) => s.openChat)
  const openSettings = useAppStore((s) => s.openSettings)
  const openResource = useAppStore((s) => s.openResource)
  const [expanded, setExpanded] = useState<Record<string, boolean>>(readSidebarExpanded)
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_EXPANDED_STORAGE_KEY, JSON.stringify(expanded))
    } catch {
      // Ignore storage failures; collapsing remains functional for this session.
    }
  }, [expanded])
  const fileInput = useRef<HTMLInputElement>(null)
  const [uploadProject, setUploadProject] = useState<string | null>(null)
  const [previewRes, setPreviewRes] = useState<{ name: string; content: string } | null>(null)
  const toggle = (key: string): void => setExpanded((e) => ({ ...e, [key]: !e[key] }))
  const isOpen = (key: string): boolean => !!expanded[key]

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
    const ext = '.' + file.name.split('.').pop()?.toLowerCase()
    if (!ALLOWED_EXT.includes(ext)) {
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

  async function deleteResource(projectId: string, resourceId: string): Promise<void> {
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
    return chats.map((c) => (
      <div key={c.id} className="group flex items-center gap-1 py-0.5 pl-9 pr-1 text-[13px] hover:bg-[var(--panel3)]">
        <MessageSquare size={13} style={{ color: 'var(--muted)' }} />
        <span className="min-w-0 flex-1 cursor-pointer truncate" onClick={() => openChat(c)} title={c.title}>
          {c.title}
        </span>
        <ActionBadge chat={c} />
        <div className="hidden gap-0.5 group-hover:flex">
          <TitleButton chatId={c.id} />
          <IconButton icon={<Trash2 size={12} />} title={t('sidebar.delete')} onClick={() => void deleteChat(c)} />
        </div>
      </div>
    ))
  }

  return (
    <div className="flex w-[260px] shrink-0 flex-col border-r" style={{ background: 'var(--panel)', borderColor: 'var(--border)' }}>
      <input
        ref={fileInput}
        type="file"
        accept=".txt,.md,.csv"
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

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {workspace.projects.length === 0 && (
          <div className="px-3 py-6 text-center text-xs" style={{ color: 'var(--muted)' }}>
            {t('sidebar.empty')}
          </div>
        )}

        {workspace.projects.map((p) => {
          const projectKey = `p:${p.project.id}`
          const projectChats = p.chats.filter((c) => !c.docId)
          const open = isOpen(projectKey)
          return (
            <div key={p.project.id} className="mb-0.5">
              <div className="group flex items-center gap-1 px-2 py-1.5 hover:bg-[var(--panel3)]">
                <button className="flex items-center gap-1" onClick={() => toggle(projectKey)}>
                  {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  {open ? <FolderOpen size={15} style={{ color: 'var(--accent)' }} /> : <Folder size={15} style={{ color: 'var(--accent)' }} />}
                </button>
                <span className="min-w-0 flex-1 truncate text-sm font-medium" title={p.project.name}>
                  {p.project.name}
                </span>
                <div className="hidden gap-0.5 group-hover:flex">
                  <IconButton icon={<FileText size={12} />} title={t('sidebar.newDoc')} onClick={() => void createDoc(p.project.id)} />
                  <IconButton icon={<MessageSquare size={12} />} title={t('sidebar.newProjChat')} onClick={() => void createChat(p.project.id)} />
                  <IconButton icon={<MoreHorizontal size={12} />} title={t('sidebar.rename')} onClick={() => void renameProject(p.project.id, p.project.name)} />
                  <IconButton icon={<Trash2 size={12} />} title={t('sidebar.deleteProject')} onClick={() => void deleteProject(p.project.id)} />
                </div>
              </div>

              {open && (
                <div>
                  <Section
                    label={t('sidebar.secDocs')}
                    open={isOpen(`${projectKey}:docs`)}
                    onToggle={() => toggle(`${projectKey}:docs`)}
                    onAdd={() => void createDoc(p.project.id)}
                  >
                    {isOpen(`${projectKey}:docs`) &&
                      p.docs.map((doc) => {
                        const docChats = p.chats.filter((chat) => chat.docId === doc.id)
                        const docChatsKey = `${projectKey}:doc:${doc.id}`
                        const docChatsOpen = expanded[docChatsKey] ?? true
                        return (
                          <div key={doc.id}>
                            <div className="group flex items-center gap-1 py-0.5 pl-6 pr-1 text-[13px] hover:bg-[var(--panel3)]">
                              <FileText size={13} style={{ color: 'var(--muted)' }} />
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
                                    toggle(docChatsKey)
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
                              <div className="hidden gap-0.5 group-hover:flex">
                                <IconButton icon={<MessageSquare size={12} />} title={t('sidebar.newDocChat')} onClick={() => void createChat(p.project.id, doc.id)} />
                                <IconButton icon={<MoreHorizontal size={12} />} title={t('sidebar.rename')} onClick={() => void renameDoc(doc)} />
                                <IconButton icon={<Trash2 size={12} />} title={t('sidebar.delete')} onClick={() => void deleteDoc(doc)} />
                              </div>
                            </div>
                            {docChatsOpen && renderDocChats(p, doc)}
                          </div>
                        )
                      })}
                  </Section>

                  <Section
                    label={t('sidebar.secChats')}
                    open={isOpen(`${projectKey}:chats`)}
                    onToggle={() => toggle(`${projectKey}:chats`)}
                    onAdd={() => void createChat(p.project.id)}
                  >
                    {isOpen(`${projectKey}:chats`) &&
                      projectChats.map((c) => (
                        <div key={c.id} className="group flex items-center gap-1 py-0.5 pl-6 pr-1 text-[13px] hover:bg-[var(--panel3)]">
                          <MessageSquare size={13} style={{ color: 'var(--muted)' }} />
                          <span className="min-w-0 flex-1 cursor-pointer truncate" onClick={() => openChat(c)} title={c.title}>
                            {c.title}
                          </span>
                          <div className="hidden gap-0.5 group-hover:flex">
                            <TitleButton chatId={c.id} />
                            <IconButton icon={<Trash2 size={12} />} title={t('sidebar.delete')} onClick={() => void deleteChat(c)} />
                          </div>
                        </div>
                      ))}
                  </Section>

                  <Section label={t('sidebar.secResources')} open={isOpen(`${projectKey}:res`)} onToggle={() => toggle(`${projectKey}:res`)} onAdd={() => void uploadResource(p.project.id)}>
                    {isOpen(`${projectKey}:res`) &&
                      p.resources.map((r) => (
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
                            <IconButton icon={<FlaskConical size={12} />} title={t('sidebar.distill')} onClick={() => void runDistill(p.project.id, r.id)} />
                            <IconButton icon={<Trash2 size={12} />} title={t('sidebar.delete')} onClick={() => void deleteResource(p.project.id, r.id)} />
                          </div>
                        </div>
                      ))}
                  </Section>

                  <Section label={t('sidebar.secSummary')} open={isOpen(`${projectKey}:summary`)} onToggle={() => toggle(`${projectKey}:summary`)}>
                    {isOpen(`${projectKey}:summary`) && <SummaryArea projectId={p.project.id} />}
                  </Section>
                </div>
              )}
            </div>
          )
        })}
      </div>

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
    </div>
  )
}

function IconButton({ icon, title, onClick, disabled }: { icon: JSX.Element; title: string; onClick: () => void; disabled?: boolean }): JSX.Element {
  return (
    <button
      className="rounded p-0.5 hover:opacity-70 disabled:opacity-40 disabled:hover:opacity-40"
      style={{ color: 'var(--muted)' }}
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
