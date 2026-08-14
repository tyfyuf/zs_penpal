import { useRef, useState, type ReactNode } from 'react'
import {
  Archive,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Settings,
  Trash2,
  Upload
} from 'lucide-react'
import type { ChatMeta, DocMeta, ProjectTree } from '@shared/types'
import { useAppStore } from '../../store/app.store'
import { api } from '../../lib/api'
import { toast } from '../../store/toast.store'
import { confirmDialog, promptText } from '../../store/dialog.store'

const ALLOWED_EXT = ['.txt', '.md', '.csv']

export default function Sidebar(): JSX.Element {
  const workspace = useAppStore((s) => s.workspace)
  const refresh = useAppStore((s) => s.refreshWorkspace)
  const openDoc = useAppStore((s) => s.openDoc)
  const openChat = useAppStore((s) => s.openChat)
  const openSettings = useAppStore((s) => s.openSettings)
  const openResource = useAppStore((s) => s.openResource)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const fileInput = useRef<HTMLInputElement>(null)
  const [uploadProject, setUploadProject] = useState<string | null>(null)

  const toggle = (key: string): void => setExpanded((e) => ({ ...e, [key]: !e[key] }))
  const isOpen = (key: string): boolean => !!expanded[key]

  async function promptName(label: string, def = ''): Promise<string | null> {
    return promptText(label, def)
  }

  async function createProject(): Promise<void> {
    const name = await promptName('项目名称')
    if (!name) return
    try {
      await api.invoke('project:create', { name })
      await refresh()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function createDoc(projectId: string): Promise<void> {
    const title = await promptName('文档标题', '未命名文档')
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
    const title = await promptName('对话标题', '新对话')
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
    const name = await promptName('重命名项目', current)
    if (!name) return
    await api.invoke('project:rename', { projectId, name })
    await refresh()
  }

  async function deleteProject(projectId: string): Promise<void> {
    if (!(await confirmDialog('删除项目？项目将进入回收站，可恢复。'))) return
    await api.invoke('project:delete', projectId)
    await refresh()
  }

  async function renameDoc(doc: DocMeta): Promise<void> {
    const title = await promptName('重命名文档', doc.title)
    if (!title) return
    await api.invoke('doc:rename', { docId: doc.id, title })
    await refresh()
  }

  async function deleteDoc(doc: DocMeta): Promise<void> {
    if (!(await confirmDialog('删除文档？文档将进入回收站，可恢复。'))) return
    await api.invoke('doc:delete', doc.id)
    await refresh()
  }

  async function deleteChat(chat: ChatMeta): Promise<void> {
    if (!(await confirmDialog('删除对话？对话将进入归档区，可恢复。'))) return
    await api.invoke('chat:delete', chat.id)
    await refresh()
  }

  async function restoreChat(chat: ChatMeta): Promise<void> {
    await api.invoke('chat:restore', chat.id)
    await refresh()
  }

  async function purgeChat(chat: ChatMeta): Promise<void> {
    if (!(await confirmDialog('彻底删除该对话？此操作不可恢复。'))) return
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
      toast.error('仅支持 .txt / .md / .csv 文本文件')
      return
    }
    const content = await file.text()
    try {
      await api.invoke('resource:upload', { projectId, name: file.name, content })
      await refresh()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function deleteResource(projectId: string, resourceId: string): Promise<void> {
    if (!(await confirmDialog('删除该资源文件？'))) return
    await api.invoke('resource:delete', { projectId, resourceId })
    await refresh()
  }

  async function restoreDoc(doc: DocMeta): Promise<void> {
    await api.invoke('doc:restore', doc.id)
    await refresh()
  }

  async function purgeDoc(doc: DocMeta): Promise<void> {
    if (!(await confirmDialog('彻底删除该文档？关联对话将转为孤儿对话进入归档区。'))) return
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
        <IconButton icon={<Trash2 size={12} />} title="删除" onClick={() => void deleteChat(c)} />
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
          <div className="truncate text-sm font-semibold">WritingAgent</div>
          <div className="truncate text-[11px]" style={{ color: 'var(--muted)' }} title={workspace.workspaceDir}>
            {workspace.workspaceDir || '未设置工作目录'}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <IconButton icon={<Plus size={15} />} title="新建项目" onClick={() => void createProject()} />
          <IconButton icon={<Settings size={15} />} title="设置" onClick={openSettings} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {workspace.projects.length === 0 && (
          <div className="px-3 py-6 text-center text-xs" style={{ color: 'var(--muted)' }}>
            暂无项目，点击左上角 + 新建
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
                  <IconButton icon={<FileText size={12} />} title="新建文档" onClick={() => void createDoc(p.project.id)} />
                  <IconButton icon={<MessageSquare size={12} />} title="新建项目对话" onClick={() => void createChat(p.project.id)} />
                  <IconButton icon={<MoreHorizontal size={12} />} title="重命名" onClick={() => void renameProject(p.project.id, p.project.name)} />
                  <IconButton icon={<Trash2 size={12} />} title="删除项目" onClick={() => void deleteProject(p.project.id)} />
                </div>
              </div>

              {open && (
                <div>
                  <Section
                    label="写作文档"
                    open={isOpen(`${projectKey}:docs`)}
                    onToggle={() => toggle(`${projectKey}:docs`)}
                    onAdd={() => void createDoc(p.project.id)}
                  >
                    {isOpen(`${projectKey}:docs`) &&
                      p.docs.map((doc) => (
                        <div key={doc.id}>
                          <div className="group flex items-center gap-1 py-0.5 pl-6 pr-1 text-[13px] hover:bg-[var(--panel3)]">
                            <FileText size={13} style={{ color: 'var(--muted)' }} />
                            <span
                              className="min-w-0 flex-1 cursor-pointer truncate"
                              onClick={() => openDoc(doc)}
                              title={doc.title}
                            >
                              {doc.title}
                            </span>
                            <div className="hidden gap-0.5 group-hover:flex">
                              <IconButton icon={<MessageSquare size={12} />} title="新建文档对话" onClick={() => void createChat(p.project.id, doc.id)} />
                              <IconButton icon={<MoreHorizontal size={12} />} title="重命名" onClick={() => void renameDoc(doc)} />
                              <IconButton icon={<Trash2 size={12} />} title="删除" onClick={() => void deleteDoc(doc)} />
                            </div>
                          </div>
                          {renderDocChats(p, doc)}
                        </div>
                      ))}
                  </Section>

                  <Section
                    label="项目对话"
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
                            <IconButton icon={<Trash2 size={12} />} title="删除" onClick={() => void deleteChat(c)} />
                          </div>
                        </div>
                      ))}
                  </Section>

                  <Section label="资源" open={isOpen(`${projectKey}:res`)} onToggle={() => toggle(`${projectKey}:res`)} onAdd={() => void uploadResource(p.project.id)}>
                    {isOpen(`${projectKey}:res`) &&
                      p.resources.map((r) => (
                        <div key={r.id} className="group flex items-center gap-1 py-0.5 pl-6 pr-1 text-[13px] hover:bg-[var(--panel3)]">
                          <FileText size={13} style={{ color: 'var(--muted)' }} />
                          <span className="min-w-0 flex-1 cursor-pointer truncate" onClick={() => openResource(p.project.id, r.id, r.name)} title={r.name}>
                            {r.name}
                          </span>
                          <div className="hidden gap-0.5 group-hover:flex">
                            <IconButton icon={<Trash2 size={12} />} title="删除" onClick={() => void deleteResource(p.project.id, r.id)} />
                          </div>
                        </div>
                      ))}
                  </Section>

                  <Section label="归档区" open={isOpen(`${projectKey}:archive`)} onToggle={() => toggle(`${projectKey}:archive`)}>
                    {isOpen(`${projectKey}:archive`) &&
                      p.archivedChats.map((c) => (
                        <div key={c.id} className="group flex items-center gap-1 py-0.5 pl-6 pr-1 text-[13px] hover:bg-[var(--panel3)]">
                          <Archive size={13} style={{ color: 'var(--muted)' }} />
                          <span className="min-w-0 flex-1 truncate" title={c.title}>
                            {c.title}
                          </span>
                          <div className="hidden gap-0.5 group-hover:flex">
                            <IconButton icon={<Plus size={12} />} title="恢复" onClick={() => void restoreChat(c)} />
                            <IconButton icon={<Trash2 size={12} />} title="彻底删除" onClick={() => void purgeChat(c)} />
                          </div>
                        </div>
                      ))}
                  </Section>

                  {p.trashedDocs.length > 0 && (
                    <Section label="回收站" open={isOpen(`${projectKey}:trash`)} onToggle={() => toggle(`${projectKey}:trash`)}>
                      {isOpen(`${projectKey}:trash`) &&
                        p.trashedDocs.map((doc) => (
                          <div key={doc.id} className="group flex items-center gap-1 py-0.5 pl-6 pr-1 text-[13px] hover:bg-[var(--panel3)]">
                            <Trash2 size={13} style={{ color: 'var(--muted)' }} />
                            <span className="min-w-0 flex-1 truncate">{doc.title}</span>
                            <div className="hidden gap-0.5 group-hover:flex">
                              <IconButton icon={<Plus size={12} />} title="恢复" onClick={() => void restoreDoc(doc)} />
                              <IconButton icon={<Trash2 size={12} />} title="彻底删除" onClick={() => void purgeDoc(doc)} />
                            </div>
                          </div>
                        ))}
                    </Section>
                  )}
                </div>
              )}
            </div>
          )
        })}

        {workspace.trashedProjects.length > 0 && (
          <div className="mt-3 border-t px-2 pt-2" style={{ borderColor: 'var(--border)' }}>
            <div className="mb-1 px-1 text-[11px] font-medium" style={{ color: 'var(--muted)' }}>
              项目回收站
            </div>
            {workspace.trashedProjects.map((p) => (
              <div key={p.id} className="group flex items-center gap-1 px-2 py-1 text-[13px] hover:bg-[var(--panel3)]">
                <Trash2 size={13} style={{ color: 'var(--muted)' }} />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                <div className="hidden gap-0.5 group-hover:flex">
                  <IconButton
                    icon={<Plus size={12} />}
                    title="恢复项目"
                    onClick={async () => {
                      await api.invoke('project:restore', p.id)
                      await refresh()
                    }}
                  />
                  <IconButton
                    icon={<Trash2 size={12} />}
                    title="彻底删除项目"
                    onClick={async () => {
                      if (!(await confirmDialog('彻底删除该项目？其下所有数据将一并删除。'))) return
                      await api.invoke('project:purge', p.id)
                      await refresh()
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function IconButton({ icon, title, onClick }: { icon: JSX.Element; title: string; onClick: () => void }): JSX.Element {
  return (
    <button
      className="rounded p-0.5 hover:opacity-70"
      style={{ color: 'var(--muted)' }}
      title={title}
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
