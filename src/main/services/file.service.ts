import { join } from 'path'
import { basename } from 'path'
import { mkdir, readdir, readFile, rm } from 'fs/promises'
import type {
  ChatKind,
  ChatMessage,
  ChatMeta,
  ChatSummary,
  DocMeta,
  DocRollup,
  DocSummary,
  ProjectMeta,
  ProjectTree,
  ResourceMeta,
  ResourceSummary,
  UploadResult,
  WorkspaceSnapshot
} from '@shared/types'
import { getConfigCached } from './config.service'
import { appendJsonl, atomicWrite, atomicWriteJson, newId, nowIso, readJson, readJsonl } from '../util'
import { computeSourceInfo } from '../summary-source'

// ---------------------------------------------------------------------------
// 目录结构（依据 tech-stack 7.2，生命周期状态存于元数据 JSON，不依赖目录移动）
// <workspace>/app-index.json
// <workspace>/<project-id>/{ meta.json, docs/, chats/, summaries/, resources/, .git/ }
//   docs/<doc-id>.meta.json + <doc-id>.md
//   chats/<chat-id>.meta.json + <chat-id>.jsonl + <chat-id>.snap-<snapshotId>.json
//   summaries/docs/<doc-id>.json  summaries/chats/<chat-id>.json
//   resources/<file-id>/meta.json + content
// ---------------------------------------------------------------------------

interface AppIndex {
  version: number
  projects: ProjectMeta[]
}

function wsRoot(): string {
  const dir = getConfigCached().workspaceDir
  if (!dir) throw new Error('workspace not configured')
  return dir
}

function indexPath(): string {
  return join(wsRoot(), 'app-index.json')
}

function projectDir(projectId: string): string {
  return join(wsRoot(), projectId)
}

function docsDir(projectId: string): string {
  return join(projectDir(projectId), 'docs')
}
function docMetaPath(projectId: string, docId: string): string {
  return join(docsDir(projectId), `${docId}.meta.json`)
}
function docContentPath(projectId: string, docId: string): string {
  return join(docsDir(projectId), `${docId}.md`)
}

function chatsDir(projectId: string): string {
  return join(projectDir(projectId), 'chats')
}
function chatMetaPath(projectId: string, chatId: string): string {
  return join(chatsDir(projectId), `${chatId}.meta.json`)
}
function chatJsonlPath(projectId: string, chatId: string): string {
  return join(chatsDir(projectId), `${chatId}.jsonl`)
}
function chatSnapshotPath(projectId: string, chatId: string, snapshotId: string): string {
  return join(chatsDir(projectId), `${chatId}.snap-${snapshotId}.json`)
}

function summariesDir(projectId: string): string {
  return join(projectDir(projectId), 'summaries')
}
function docSummaryPath(projectId: string, docId: string): string {
  return join(summariesDir(projectId), 'docs', `${docId}.json`)
}
function chatSummaryPath(projectId: string, chatId: string): string {
  return join(summariesDir(projectId), 'chats', `${chatId}.json`)
}
function resourceSummaryPath(projectId: string, resourceId: string): string {
  return join(summariesDir(projectId), 'resources', `${resourceId}.json`)
}
function rollupsPath(projectId: string): string {
  return join(summariesDir(projectId), 'rollups', `${projectId}.json`)
}

function resourcesDir(projectId: string): string {
  return join(projectDir(projectId), 'resources')
}
function resourceDir(projectId: string, fileId: string): string {
  return join(resourcesDir(projectId), fileId)
}
function resourceMetaPath(projectId: string, fileId: string): string {
  return join(resourceDir(projectId, fileId), 'meta.json')
}
function resourceContentPath(projectId: string, fileId: string): string {
  return join(resourceDir(projectId, fileId), 'content')
}

// ---------------------------------------------------------------------------
// 工作目录索引
// ---------------------------------------------------------------------------

async function loadIndex(): Promise<AppIndex> {
  return (await readJson<AppIndex>(indexPath())) ?? { version: 1, projects: [] }
}

async function saveIndex(idx: AppIndex): Promise<void> {
  await atomicWriteJson(indexPath(), idx)
}

export async function ensureWorkspace(): Promise<void> {
  const root = wsRoot()
  await mkdir(root, { recursive: true })
  await mkdir(indexPath().replace('app-index.json', ''), { recursive: true })
  if ((await readJson<AppIndex>(indexPath())) === null) {
    await saveIndex({ version: 1, projects: [] })
  }
}

async function mutateProject(projectId: string, patch: Partial<ProjectMeta>): Promise<ProjectMeta> {
  const idx = await loadIndex()
  const i = idx.projects.findIndex((p) => p.id === projectId)
  if (i < 0) throw new Error('project not found')
  idx.projects[i] = { ...idx.projects[i], ...patch, updatedAt: nowIso() }
  await saveIndex(idx)
  // 同步写入项目目录 meta.json，供 Git 跟踪
  await atomicWriteJson(join(projectDir(projectId), 'meta.json'), idx.projects[i])
  return idx.projects[i]
}

// ---------------------------------------------------------------------------
// 项目
// ---------------------------------------------------------------------------

export async function listProjects(status?: ProjectMeta['status']): Promise<ProjectMeta[]> {
  const idx = await loadIndex()
  return status ? idx.projects.filter((p) => p.status === status) : idx.projects
}

export async function createProject(name: string): Promise<ProjectMeta> {
  await ensureWorkspace()
  const idx = await loadIndex()
  const id = newId()
  const meta: ProjectMeta = { id, name, status: 'normal', createdAt: nowIso(), updatedAt: nowIso() }
  idx.projects.push(meta)
  await saveIndex(idx)
  await mkdir(projectDir(id), { recursive: true })
  await atomicWriteJson(join(projectDir(id), 'meta.json'), meta)
  return meta
}

export async function renameProject(projectId: string, name: string): Promise<ProjectMeta> {
  return mutateProject(projectId, { name })
}

export async function deleteProject(projectId: string): Promise<void> {
  await mutateProject(projectId, { status: 'trash' })
}

export async function restoreProject(projectId: string): Promise<ProjectMeta> {
  return mutateProject(projectId, { status: 'normal' })
}

export async function purgeProject(projectId: string): Promise<void> {
  const idx = await loadIndex()
  idx.projects = idx.projects.filter((p) => p.id !== projectId)
  await saveIndex(idx)
  await rm(projectDir(projectId), { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// 文档
// ---------------------------------------------------------------------------

async function listDocMetas(projectId: string): Promise<DocMeta[]> {
  let entries: string[] = []
  try {
    entries = await readdir(docsDir(projectId))
  } catch {
    return []
  }
  const metas: DocMeta[] = []
  for (const f of entries) {
    if (!f.endsWith('.meta.json')) continue
    const meta = await readJson<DocMeta>(join(docsDir(projectId), f))
    if (meta) metas.push(meta)
  }
  return metas
}

export async function createDoc(projectId: string, title: string): Promise<DocMeta> {
  const id = newId()
  const meta: DocMeta = { id, projectId, title, status: 'normal', createdAt: nowIso(), updatedAt: nowIso() }
  await atomicWriteJson(docMetaPath(projectId, id), meta)
  // 新建文档：UTF-8，空内容（LF）
  await atomicWrite(docContentPath(projectId, id), '')
  return meta
}

async function getDocMeta(projectId: string, docId: string): Promise<DocMeta> {
  const meta = await readJson<DocMeta>(docMetaPath(projectId, docId))
  if (!meta) throw new Error('doc not found')
  return meta
}

export async function readDoc(docId: string): Promise<{ doc: DocMeta; content: string }> {
  const doc = await findDocMeta(docId)
  const { readFile } = await import('fs/promises')
  const content = await readFile(docContentPath(doc.projectId, docId), 'utf8')
  return { doc, content }
}

/** 跨项目查找文档元数据（用于 readDoc 等按 id 定位的场景） */
export async function findDocMeta(docId: string): Promise<DocMeta> {
  const projects = await listProjects()
  for (const p of projects) {
    const meta = await readJson<DocMeta>(docMetaPath(p.id, docId))
    if (meta) return meta
  }
  throw new Error('doc not found')
}

export async function saveDoc(docId: string, content: string): Promise<void> {
  const doc = await findDocMeta(docId)
  await atomicWrite(docContentPath(doc.projectId, docId), content)
  const meta = await getDocMeta(doc.projectId, docId)
  await atomicWriteJson(docMetaPath(doc.projectId, docId), { ...meta, updatedAt: nowIso() })
}

export async function renameDoc(docId: string, title: string): Promise<DocMeta> {
  const doc = await findDocMeta(docId)
  const meta = await getDocMeta(doc.projectId, docId)
  const next = { ...meta, title, updatedAt: nowIso() }
  await atomicWriteJson(docMetaPath(doc.projectId, docId), next)
  return next
}

export async function deleteDoc(docId: string): Promise<void> {
  const doc = await findDocMeta(docId)
  const meta = await getDocMeta(doc.projectId, docId)
  await atomicWriteJson(docMetaPath(doc.projectId, docId), { ...meta, status: 'trash', updatedAt: nowIso() })
}

export async function restoreDoc(docId: string): Promise<DocMeta> {
  const doc = await findDocMeta(docId)
  const meta = await getDocMeta(doc.projectId, docId)
  const next: DocMeta = { ...meta, status: 'normal', updatedAt: nowIso() }
  await atomicWriteJson(docMetaPath(doc.projectId, docId), next)
  return next
}

/**
 * 彻底删除文档（PRD 4.1.3 / 4.1.5）：
 * - 文档本体 + 文档摘要删除
 * - 仍关联的文档级对话 → 孤儿归档
 * - 已被用户单独归档的文档级对话 → 一并移除
 */
export async function purgeDoc(docId: string): Promise<void> {
  const doc = await findDocMeta(docId)
  const projectId = doc.projectId
  await rm(docMetaPath(projectId, docId), { force: true })
  await rm(docContentPath(projectId, docId), { force: true })
  await rm(docSummaryPath(projectId, docId), { force: true })

  const chats = await listChatMetas(projectId)
  for (const chat of chats) {
    if (chat.docId !== docId) continue
    if (chat.status === 'user_archived') {
      await purgeChat(chat.id)
    } else {
      await atomicWriteJson(chatMetaPath(projectId, chat.id), {
        ...chat,
        status: 'orphan_archived',
        updatedAt: nowIso()
      })
    }
  }
}

// ---------------------------------------------------------------------------
// 对话
// ---------------------------------------------------------------------------

async function listChatMetas(projectId: string): Promise<ChatMeta[]> {
  let entries: string[] = []
  try {
    entries = await readdir(chatsDir(projectId))
  } catch {
    return []
  }
  const metas: ChatMeta[] = []
  for (const f of entries) {
    if (!f.endsWith('.meta.json')) continue
    const meta = await readJson<ChatMeta>(join(chatsDir(projectId), f))
    if (meta) metas.push(meta)
  }
  return metas
}

async function getChatMeta(chatId: string): Promise<ChatMeta> {
  const projects = await listProjects()
  for (const p of projects) {
    const meta = await readJson<ChatMeta>(chatMetaPath(p.id, chatId))
    if (meta) return meta
  }
  throw new Error('chat not found')
}

export async function createChat(
  projectId: string,
  kind: ChatKind,
  title: string,
  docId?: string,
  contextRange?: import('@shared/types').ContextRange,
  action?: import('@shared/types').ChatAction
): Promise<ChatMeta> {
  const id = newId()
  const meta: ChatMeta = {
    id,
    projectId,
    kind,
    docId,
    title,
    status: 'normal',
    createdAt: nowIso(),
    updatedAt: nowIso()
  }
  if (kind === 'context') {
    meta.contextRange = contextRange
    if (action) meta.action = action
  }
  await atomicWriteJson(chatMetaPath(projectId, id), meta)
  await atomicWrite(chatJsonlPath(projectId, id), '')
  return meta
}

/** 更新对话 meta 的可变字段（contextRange / lockedRange / injectionOverrides） */
export async function updateChatMeta(
  chatId: string,
  patch: Partial<Pick<ChatMeta, 'contextRange' | 'lockedRange' | 'injectionOverrides'>>
): Promise<ChatMeta> {
  const chat = await getChatMeta(chatId)
  const next = { ...chat, ...patch, updatedAt: nowIso() }
  await atomicWriteJson(chatMetaPath(chat.projectId, chatId), next)
  return next
}

export async function getChat(chatId: string): Promise<{ chat: ChatMeta; messages: ChatMessage[] }> {
  const chat = await getChatMeta(chatId)
  const messages = await readJsonl<ChatMessage>(chatJsonlPath(chat.projectId, chatId))
  return { chat, messages }
}

export async function renameChat(chatId: string, title: string): Promise<ChatMeta> {
  const chat = await getChatMeta(chatId)
  const next = { ...chat, title, updatedAt: nowIso() }
  await atomicWriteJson(chatMetaPath(chat.projectId, chatId), next)
  return next
}

/** 更新上下文对话的上下文范围（PRD 6.4 / 6.6） */
export async function updateChatContext(
  chatId: string,
  contextRange: import('@shared/types').ContextRange
): Promise<ChatMeta> {
  const chat = await getChatMeta(chatId)
  const next = { ...chat, contextRange, updatedAt: nowIso() }
  await atomicWriteJson(chatMetaPath(chat.projectId, chatId), next)
  return next
}

export async function appendMessage(chatId: string, message: ChatMessage): Promise<void> {
  const chat = await getChatMeta(chatId)
  await appendJsonl(chatJsonlPath(chat.projectId, chatId), message)
  await atomicWriteJson(chatMetaPath(chat.projectId, chatId), { ...chat, updatedAt: nowIso() })
}

/** 替换最近一条 assistant 回答（重新生成场景，PRD 6.6）；reasoning 为思维链（可空） */
export async function replaceLastAssistantMessage(chatId: string, content: string, reasoning?: string): Promise<void> {
  const { chat, messages } = await getChat(chatId)
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      messages[i] = { ...messages[i], content, regenerated: true }
      if (reasoning) messages[i].reasoning = reasoning
      break
    }
  }
  await atomicWrite(chatJsonlPath(chat.projectId, chatId), messages.map((m) => JSON.stringify(m)).join('\n') + (messages.length ? '\n' : ''))
  await atomicWriteJson(chatMetaPath(chat.projectId, chatId), { ...chat, updatedAt: nowIso() })
}

/** 用户归档对话（PRD 4.2.1） */
export async function deleteChat(chatId: string): Promise<void> {
  const chat = await getChatMeta(chatId)
  await atomicWriteJson(chatMetaPath(chat.projectId, chatId), { ...chat, status: 'user_archived', updatedAt: nowIso() })
}

/** 从归档区恢复对话（PRD 4.2.3） */
export async function restoreChat(chatId: string): Promise<ChatMeta> {
  const chat = await getChatMeta(chatId)
  // 原关联文档仍存在（未进回收站）则恢复原关联；否则恢复为项目级对话
  let kind: ChatKind = chat.kind
  let docId = chat.docId
  if (chat.kind === 'doc' || chat.kind === 'context') {
    const docMeta = docId ? await readJson<DocMeta>(docMetaPath(chat.projectId, docId)) : null
    if (!docMeta || docMeta.status === 'trash') {
      kind = 'project'
      docId = undefined
    }
  }
  const next = { ...chat, kind, docId, status: 'normal' as const, updatedAt: nowIso() }
  await atomicWriteJson(chatMetaPath(chat.projectId, chatId), next)
  return next
}

export async function purgeChat(chatId: string): Promise<void> {
  const chat = await getChatMeta(chatId)
  await rm(chatMetaPath(chat.projectId, chatId), { force: true })
  await rm(chatJsonlPath(chat.projectId, chatId), { force: true })
  await rm(chatSummaryPath(chat.projectId, chatId), { force: true })
  // 删除该对话的快照文件
  const { readdir } = await import('fs/promises')
  let entries: string[] = []
  try {
    entries = await readdir(chatsDir(chat.projectId))
  } catch {
    entries = []
  }
  for (const f of entries) {
    if (f.startsWith(`${chatId}.snap-`)) {
      await rm(join(chatsDir(chat.projectId), f), { force: true })
    }
  }
}

// ---------------------------------------------------------------------------
// 资源与快照
// ---------------------------------------------------------------------------

export async function listResources(projectId: string): Promise<ResourceMeta[]> {
  let entries: string[] = []
  try {
    entries = await readdir(resourcesDir(projectId))
  } catch {
    return []
  }
  const metas: ResourceMeta[] = []
  for (const dir of entries) {
    const meta = await readJson<ResourceMeta>(resourceMetaPath(projectId, dir))
    if (meta) metas.push(meta)
  }
  return metas
}

export async function uploadResource(
  projectId: string,
  name: string,
  content: string
): Promise<ResourceMeta> {
  const id = newId()
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : 'txt'
  const meta: ResourceMeta = { id, projectId, name, ext, size: Buffer.byteLength(content, 'utf8'), createdAt: nowIso() }
  await atomicWriteJson(resourceMetaPath(projectId, id), meta)
  await atomicWrite(resourceContentPath(projectId, id), content)
  return meta
}

export async function readResource(projectId: string, resourceId: string): Promise<{ content: string; name: string }> {
  const { readFile } = await import('fs/promises')
  const meta = await readJson<ResourceMeta>(resourceMetaPath(projectId, resourceId))
  const content = await readFile(resourceContentPath(projectId, resourceId), 'utf8')
  return { content, name: meta?.name ?? resourceId }
}

export async function deleteResource(projectId: string, resourceId: string): Promise<void> {
  await rm(resourceDir(projectId, resourceId), { recursive: true, force: true })
  // 资源删除 → 其摘要一并移除（资源摘要生命周期）
  await rm(resourceSummaryPath(projectId, resourceId), { force: true })
}

/**
 * 单实例文件关联：打开外部文本文件（PRD 1.5 / 9.24 / 9.29）。
 * 非文本文件拒绝；文件不属于任何项目时自动创建项目并作为资源导入。
 */
export async function importExternalFile(filePath: string): Promise<{
  ok: boolean
  error?: string
  projectId?: string
  resourceId?: string
  name?: string
  content?: string
  created?: boolean
}> {
  const dot = filePath.lastIndexOf('.')
  const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : ''
  if (!['.txt', '.md', '.csv'].includes(ext)) {
    return { ok: false, error: '不支持的文件类型，仅支持 .txt / .md / .csv' }
  }
  let content: string
  try {
    content = await readFile(filePath, 'utf8')
  } catch (err) {
    return { ok: false, error: `无法读取文件：${(err as Error).message}` }
  }
  const name = basename(filePath)

  // 查找是否已属于某项目（按同名资源匹配）
  const projects = await listProjects()
  for (const p of projects) {
    if (p.status !== 'normal') continue
    const resources = await listResources(p.id)
    const existing = resources.find((r) => r.name === name)
    if (existing) {
      const res = await readResource(p.id, existing.id)
      return { ok: true, projectId: p.id, resourceId: existing.id, name, content: res.content, created: false }
    }
  }

  // 新建项目并作为资源导入
  const base = name.replace(/\.[^.]+$/, '') || '导入文件'
  const project = await createProject(base)
  const resource = await uploadResource(project.id, name, content)
  return { ok: true, projectId: project.id, resourceId: resource.id, name, content, created: true }
}

interface SnapshotFile {
  id: string
  resourceId?: string
  name: string
  content: string
  createdAt: string
}

/**
 * 把资源内容以“上传时快照”写入对话内部（PRD 5.5 / 9.16）。
 * 历史会话引用该快照，后续修改/删除原资源不影响会话。
 */
export async function attachResourceSnapshot(
  chatId: string,
  projectId: string,
  source: { mode: 'resource'; resourceId: string } | { mode: 'local'; name: string; content: string }
): Promise<UploadResult> {
  const chat = await getChatMeta(chatId)
  let resource: ResourceMeta
  let content: string
  let name: string
  let resourceId: string | undefined

  if (source.mode === 'local') {
    resource = await uploadResource(projectId, source.name, source.content)
    content = source.content
    name = source.name
    resourceId = resource.id
  } else {
    const res = await readResource(projectId, source.resourceId)
    content = res.content
    name = res.name
    resource = (await readJson<ResourceMeta>(resourceMetaPath(projectId, source.resourceId)))!
    resourceId = resource.id
  }

  const snapshotId = newId()
  const snap: SnapshotFile = { id: snapshotId, resourceId, name, content, createdAt: nowIso() }
  await atomicWriteJson(chatSnapshotPath(chat.projectId, chat.id, snapshotId), snap)
  return { resource, content, snapshotId }
}

export async function readSnapshot(projectId: string, chatId: string, snapshotId: string): Promise<SnapshotFile | null> {
  return readJson<SnapshotFile>(chatSnapshotPath(projectId, chatId, snapshotId))
}

// ---------------------------------------------------------------------------
// 摘要读写
// ---------------------------------------------------------------------------

/** 读取文档摘要；旧格式（三字段版）视为无摘要；v1 内嵌全文快照版迁移为指纹 */
export async function readDocSummary(projectId: string, docId: string): Promise<DocSummary | null> {
  const s = await readJson<DocSummary & { snapshot?: string; snapshotLength?: number }>(
    docSummaryPath(projectId, docId)
  )
  if (!s || !Array.isArray(s.characters)) return null
  // 旧格式迁移：剥离内嵌全文快照，换为源指纹（省约一半存储）
  if (!s.sourceFingerprint && typeof s.snapshot === 'string') {
    const { snapshot: _snap, snapshotLength: _len, ...rest } = s
    const migrated: DocSummary = {
      ...rest,
      ...computeSourceInfo(s.snapshot),
      updatedAt: s.updatedAt ?? nowIso()
    }
    await writeDocSummary(projectId, docId, migrated)
    return migrated
  }
  return s
}

export async function writeDocSummary(projectId: string, docId: string, summary: DocSummary): Promise<void> {
  await atomicWriteJson(docSummaryPath(projectId, docId), summary)
}

/** 读取对话摘要；旧格式（单标签版）视为无摘要，触发重新生成 */
export async function readChatSummary(projectId: string, chatId: string): Promise<ChatSummary | null> {
  const s = await readJson<ChatSummary>(chatSummaryPath(projectId, chatId))
  if (!s || !Array.isArray(s.items)) return null
  return s
}

export async function writeChatSummary(projectId: string, chatId: string, summary: ChatSummary): Promise<void> {
  await atomicWriteJson(chatSummaryPath(projectId, chatId), summary)
}

export async function readResourceSummary(projectId: string, resourceId: string): Promise<ResourceSummary | null> {
  return readJson<ResourceSummary>(resourceSummaryPath(projectId, resourceId))
}

export async function writeResourceSummary(projectId: string, resourceId: string, summary: ResourceSummary): Promise<void> {
  await atomicWriteJson(resourceSummaryPath(projectId, resourceId), summary)
}

export async function removeResourceSummary(projectId: string, resourceId: string): Promise<void> {
  await rm(resourceSummaryPath(projectId, resourceId), { force: true })
}

export async function readDocRollups(projectId: string): Promise<DocRollup[]> {
  const data = await readJson<{ rollups: DocRollup[] }>(rollupsPath(projectId))
  return Array.isArray(data?.rollups) ? data.rollups : []
}

export async function writeDocRollups(projectId: string, rollups: DocRollup[]): Promise<void> {
  await atomicWriteJson(rollupsPath(projectId), { rollups })
}

// ---------------------------------------------------------------------------
// 工作区快照
// ---------------------------------------------------------------------------

async function buildProjectTree(p: ProjectMeta): Promise<ProjectTree> {
  const docs = await listDocMetas(p.id)
  const chats = await listChatMetas(p.id)
  const resources = await listResources(p.id)
  return {
    project: p,
    docs: docs.filter((d) => d.status === 'normal'),
    chats: chats.filter((c) => c.status === 'normal'),
    resources,
    archivedChats: chats.filter((c) => c.status === 'user_archived' || c.status === 'orphan_archived'),
    trashedDocs: docs.filter((d) => d.status === 'trash')
  }
}

export async function buildSnapshot(): Promise<WorkspaceSnapshot> {
  const idx = await loadIndex()
  const projects: ProjectTree[] = []
  const trashedProjects: ProjectMeta[] = []
  for (const p of idx.projects) {
    if (p.status === 'trash') trashedProjects.push(p)
    else projects.push(await buildProjectTree(p))
  }
  return { workspaceDir: wsRoot(), projects, trashedProjects }
}
