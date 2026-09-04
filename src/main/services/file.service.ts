import { join } from 'path'
import { basename } from 'path'
import { mkdir, readdir, readFile, rm } from 'fs/promises'
import type {
  ChatKind,
  ChatMessage,
  ChatMeta,
  ChatSummary,
  DocEditorFormat,
  DocMeta,
  DocRollup,
  DocSummary,
  ProjectMeta,
  ProjectTree,
  ResourceMeta,
  ResourceSummary,
  TextEncodingInfo,
  UploadResult,
  VectorIndex,
  WorkspaceSnapshot
} from '@shared/types'
import { getConfigCached } from './config.service'
import { appendJsonl, atomicWrite, atomicWriteJson, enqueueSerialized, newId, nowIso, readJson, readJsonl } from '../util'
import { computeSourceInfo, SUMMARY_SCHEMA_VERSION } from '../summary-source'
import { assertTextIntegrity, readDecodedTextFile } from './text-decoding.service'
import { convertResourceInput, type ConvertedResourceInput } from './resource-conversion.service'
import { getResourceSourceFormat, isSupportedResourceFile } from '@shared/resource-formats'
import { isSummaryGenerating } from './summary-state.service'
import { FEATURE_GUIDE_CHAT_TITLE, FEATURE_GUIDE_DOCUMENTS, FEATURE_GUIDE_PROJECT_KIND, FEATURE_GUIDE_PROJECT_NAME } from './feature-guide-content'

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
  featureGuideInitialized?: boolean
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
function settingDistillationCheckpointPath(projectId: string, resourceId: string): string {
  return join(summariesDir(projectId), 'resources', `${resourceId}.setting-v2-checkpoint.json`)
}
function rollupsPath(projectId: string): string {
  return join(summariesDir(projectId), 'rollups', `${projectId}.json`)
}
function vectorIndexPath(projectId: string): string {
  return join(summariesDir(projectId), 'vector-index', `${projectId}.json`)
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
function resourceSourcePath(projectId: string, fileId: string): string {
  return join(resourceDir(projectId, fileId), 'source.bin')
}


// ---------------------------------------------------------------------------
// 工作目录索引
// ---------------------------------------------------------------------------

async function loadIndex(): Promise<AppIndex> {
  return (await readJson<AppIndex>(indexPath())) ?? { version: 1, projects: [], featureGuideInitialized: false }
}

async function saveIndex(idx: AppIndex): Promise<void> {
  await atomicWriteJson(indexPath(), idx)
}

async function projectMetaById(projectId: string): Promise<ProjectMeta | null> {
  const idx = await loadIndex()
  return idx.projects.find((project) => project.id === projectId) ?? null
}

async function assertProjectContentMutable(projectId: string): Promise<void> {
  const project = await projectMetaById(projectId)
  if (project?.system === FEATURE_GUIDE_PROJECT_KIND) {
    throw new Error('Built-in feature guide content cannot be modified individually')
  }
}

export async function isFeatureGuideProject(projectId: string): Promise<boolean> {
  const project = await projectMetaById(projectId)
  return project?.system === FEATURE_GUIDE_PROJECT_KIND
}

let featureGuideMutation: Promise<ProjectMeta> | null = null

/**
 * Bring an already-created README project up to the current bundled guide.
 * Matching by systemOrder first and title second preserves document IDs and
 * therefore keeps renderer-side collapse state stable across guide updates.
 */
async function syncFeatureGuideProject(project: ProjectMeta): Promise<void> {
  const existingDocs = await listDocMetas(project.id)
  const unused = new Set(existingDocs.map((doc) => doc.id))
  const byOrder = new Map<number, DocMeta>()
  const byTitle = new Map<string, DocMeta>()
  const legacyOrderByTitle = new Map([
    ['快速开始', 2],
    ['工作区、项目与左侧栏', 3],
    ['写作文档编辑器', 4],
    ['对话类型与基本操作', 5],
    ['项目级对话', 6],
    ['文档级对话', 7],
    ['有滑块的文档级对话', 8],
    ['资源区', 9],
    ['资源蒸馏', 10],
    ['摘要与摘要注入', 11],
    ['大摘要与原文检索', 12],
    ['设置', 13],
    ['归档、回收站与版本管理', 14],
    ['外部文件打开与导入', 15],
    ['常见问题与使用建议', 16]
  ])
  for (const doc of existingDocs) {
    if (typeof doc.systemOrder === 'number') byOrder.set(doc.systemOrder, doc)
    byTitle.set(doc.title, doc)
  }

  for (const guide of FEATURE_GUIDE_DOCUMENTS) {
    // Prefer the new exact title, then migrate the previous unnumbered titles.
    // Only use persisted order as a fallback for documents without a known title.
    const legacy = existingDocs.find((doc) => legacyOrderByTitle.get(doc.title) === guide.order)
    const current = byTitle.get(guide.title) ?? legacy ?? byOrder.get(guide.order)
    const doc = current ?? await createDoc(project.id, guide.title, FEATURE_GUIDE_PROJECT_KIND, guide.order)
    unused.delete(doc.id)
    const next: DocMeta = {
      ...doc,
      title: guide.title,
      status: 'normal',
      system: FEATURE_GUIDE_PROJECT_KIND,
      systemOrder: guide.order,
      updatedAt: nowIso()
    }
    await atomicWrite(docContentPath(project.id, doc.id), guide.content)
    await atomicWriteJson(docMetaPath(project.id, doc.id), next)
  }

  // Remove stale documents from an older version of the built-in guide.
  for (const docId of unused) {
    await rm(docMetaPath(project.id, docId), { force: true })
    await rm(docContentPath(project.id, docId), { force: true })
  }
}

/**
 * Create or restore the built-in README project. The normal workspace startup
 * path calls this only for a workspace that has never been initialized. Once a
 * user deletes the project, it stays deleted until the explicit settings action
 * calls this function with force=true.
 */
export async function ensureFeatureGuideProject(force = false): Promise<ProjectMeta> {
  if (featureGuideMutation) return featureGuideMutation
  featureGuideMutation = (async () => {
    await ensureWorkspace()
    const idx = await loadIndex()
    const existing = idx.projects.find((project) => project.system === FEATURE_GUIDE_PROJECT_KIND)
    if (!force && existing) {
      // A normal startup must preserve a deliberately deleted (trashed) guide,
      // but an existing active guide should track the bundled tutorial content.
      if (existing.status === 'normal') await syncFeatureGuideProject(existing)
      if (!idx.featureGuideInitialized) {
        idx.featureGuideInitialized = true
        await saveIndex(idx)
      }
      return existing
    }
    if (!force && idx.featureGuideInitialized) {
      throw new Error('feature guide project is not available')
    }

    if (force && existing) {
      idx.projects = idx.projects.filter((project) => project.id !== existing.id)
      await saveIndex(idx)
      await rm(projectDir(existing.id), { recursive: true, force: true })
    }

    const project = await createProject(FEATURE_GUIDE_PROJECT_NAME, FEATURE_GUIDE_PROJECT_KIND)
    for (const guide of FEATURE_GUIDE_DOCUMENTS) {
      const doc = await createDoc(project.id, guide.title, FEATURE_GUIDE_PROJECT_KIND, guide.order)
      await atomicWrite(docContentPath(project.id, doc.id), guide.content)
      await atomicWriteJson(docMetaPath(project.id, doc.id), { ...doc, updatedAt: nowIso() })
    }
    await createChat(project.id, 'project', FEATURE_GUIDE_CHAT_TITLE, undefined, undefined, undefined, FEATURE_GUIDE_PROJECT_KIND)
    const next = await loadIndex()
    next.featureGuideInitialized = true
    await saveIndex(next)
    return project
  })()
  try {
    return await featureGuideMutation
  } finally {
    featureGuideMutation = null
  }
}

export async function featureGuideProjectExists(): Promise<boolean> {
  await ensureWorkspace()
  const idx = await loadIndex()
  return idx.projects.some((project) => project.system === FEATURE_GUIDE_PROJECT_KIND && project.status === 'normal')
}

export async function ensureWorkspace(): Promise<void> {
  const root = wsRoot()
  await mkdir(root, { recursive: true })
  await mkdir(indexPath().replace('app-index.json', ''), { recursive: true })
  if ((await readJson<AppIndex>(indexPath())) === null) {
    await saveIndex({ version: 1, projects: [], featureGuideInitialized: false })
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
// 椤圭洰
// ---------------------------------------------------------------------------

export async function listProjects(status?: ProjectMeta['status']): Promise<ProjectMeta[]> {
  const idx = await loadIndex()
  return status ? idx.projects.filter((p) => p.status === status) : idx.projects
}

export async function createProject(name: string, system?: ProjectMeta['system']): Promise<ProjectMeta> {
  await ensureWorkspace()
  const idx = await loadIndex()
  const id = newId()
  const meta: ProjectMeta = { id, name, status: 'normal', createdAt: nowIso(), updatedAt: nowIso(), ...(system ? { system } : {}) }
  idx.projects.push(meta)
  await saveIndex(idx)
  await mkdir(projectDir(id), { recursive: true })
  await atomicWriteJson(join(projectDir(id), 'meta.json'), meta)
  return meta
}

export async function renameProject(projectId: string, name: string): Promise<ProjectMeta> {
  await assertProjectContentMutable(projectId)
  return mutateProject(projectId, { name })
}

export async function setProjectSummaryAutoMaintenance(projectId: string, enabled: boolean): Promise<ProjectMeta> {
  await assertProjectContentMutable(projectId)
  return mutateProject(projectId, { summaryAutoMaintenance: enabled })
}

export async function deleteProject(projectId: string): Promise<void> {
  await mutateProject(projectId, { status: 'trash' })
}

export async function restoreProject(projectId: string): Promise<ProjectMeta> {
  const project = await projectMetaById(projectId)
  if (project?.system === FEATURE_GUIDE_PROJECT_KIND) {
    throw new Error('Built-in feature guide project can only be restored from Settings')
  }
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

export async function createDoc(projectId: string, title: string, system?: DocMeta['system'], systemOrder?: number): Promise<DocMeta> {
  if (!system) await assertProjectContentMutable(projectId)
  const id = newId()
  const meta: DocMeta = {
    id,
    projectId,
    title,
    status: 'normal',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...(system ? { system } : {}),
    ...(systemOrder === undefined ? {} : { systemOrder })
  }
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
  const { text: content } = await readDecodedTextFile(docContentPath(doc.projectId, docId))
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

async function mutateDocument<T>(docId: string, operation: () => Promise<T>): Promise<T> {
  return enqueueSerialized(`document:${docId}`, operation)
}

export async function saveDoc(docId: string, content: string, editorFormat?: DocEditorFormat): Promise<void> {
  await mutateDocument(docId, async () => {
    const doc = await findDocMeta(docId)
    await assertProjectContentMutable(doc.projectId)
    await atomicWrite(docContentPath(doc.projectId, docId), content)
    const meta = await getDocMeta(doc.projectId, docId)
    const next: DocMeta = {
      ...meta,
      ...(editorFormat === undefined ? {} : { editorFormat }),
      updatedAt: nowIso()
    }
    await atomicWriteJson(docMetaPath(doc.projectId, docId), next)
  })
}

export async function renameDoc(docId: string, title: string): Promise<DocMeta> {
  return mutateDocument(docId, async () => {
    const doc = await findDocMeta(docId)
    await assertProjectContentMutable(doc.projectId)
    const meta = await getDocMeta(doc.projectId, docId)
    const next = { ...meta, title, updatedAt: nowIso() }
    await atomicWriteJson(docMetaPath(doc.projectId, docId), next)
    return next
  })
}

export async function deleteDoc(docId: string): Promise<void> {
  await mutateDocument(docId, async () => {
    const doc = await findDocMeta(docId)
    await assertProjectContentMutable(doc.projectId)
    const meta = await getDocMeta(doc.projectId, docId)
    await atomicWriteJson(docMetaPath(doc.projectId, docId), { ...meta, status: 'trash', updatedAt: nowIso() })
  })
}

export async function restoreDoc(docId: string): Promise<DocMeta> {
  return mutateDocument(docId, async () => {
    const doc = await findDocMeta(docId)
    await assertProjectContentMutable(doc.projectId)
    const meta = await getDocMeta(doc.projectId, docId)
    const next: DocMeta = { ...meta, status: 'normal', updatedAt: nowIso() }
    await atomicWriteJson(docMetaPath(doc.projectId, docId), next)
    return next
  })
}

/**
 * 彻底删除文档（PRD 4.1.3 / 4.1.5）：
 * - 文档本体 + 文档摘要删除
 * - 从关联的文档级对话 → 孤儿归档
 * - 已被用户单独归档的文档级对话 → 一并移除
 */
export async function purgeDoc(docId: string): Promise<void> {
  await mutateDocument(docId, async () => {
    const doc = await findDocMeta(docId)
    await assertProjectContentMutable(doc.projectId)
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
        await mutateChatMeta(chat.id, (current) => ({
          ...current,
          status: 'orphan_archived',
          updatedAt: nowIso()
        }))
      }
    }
  })
}

// ---------------------------------------------------------------------------
// 瀵硅瘽
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

/**
 * Serialize the complete read-modify-write transaction for one chat meta file.
 * atomicWriteJson serializes writes only; two callers can still read the same
 * old snapshot and let the later write erase fields added by the earlier one.
 */
const chatMetaMutationQueues = new Map<string, Promise<void>>()

async function mutateChatMeta(
  chatId: string,
  mutate: (current: ChatMeta) => ChatMeta | Promise<ChatMeta>
): Promise<ChatMeta> {
  const previous = chatMetaMutationQueues.get(chatId) ?? Promise.resolve()
  let result: ChatMeta | undefined
  const next = previous.catch(() => {}).then(async () => {
    const current = await getChatMeta(chatId)
    result = await mutate(current)
    await atomicWriteJson(chatMetaPath(result.projectId, chatId), result)
  })
  chatMetaMutationQueues.set(chatId, next)
  try {
    await next
    return result!
  } finally {
    if (chatMetaMutationQueues.get(chatId) === next) chatMetaMutationQueues.delete(chatId)
  }
}

export async function createChat(
  projectId: string,
  kind: ChatKind,
  title: string,
  docId?: string,
  contextRange?: import('@shared/types').ContextRange,
  action?: import('@shared/types').ChatAction,
  system?: ChatMeta['system']
): Promise<ChatMeta> {
  if (!system) await assertProjectContentMutable(projectId)
  const id = newId()
  const meta: ChatMeta = {
    id,
    projectId,
    kind,
    docId,
    title,
    status: 'normal',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...(system ? { system } : {})
  }
  if (kind === 'context') {
    meta.contextRange = contextRange
    if (action) meta.action = action
  }
  await atomicWriteJson(chatMetaPath(projectId, id), meta)
  await atomicWrite(chatJsonlPath(projectId, id), '')
  return meta
}

/** 更新对话 meta 的可变字段（contextRange / lockedRange / injectionOverrides）*/
export async function updateChatMeta(
  chatId: string,
  patch: Partial<Pick<ChatMeta, 'contextRange' | 'lockedRange' | 'injectionOverrides' | 'summaryLearning'>>
): Promise<ChatMeta> {
  return mutateChatMeta(chatId, (chat) => {
    if (chat.system === FEATURE_GUIDE_PROJECT_KIND) {
      throw new Error('Built-in feature guide chat cannot be modified')
    }
    return { ...chat, ...patch, updatedAt: nowIso() }
  })
}

export async function getChat(chatId: string): Promise<{ chat: ChatMeta; messages: ChatMessage[] }> {
  const chat = await getChatMeta(chatId)
  const messages = await readJsonl<ChatMessage>(chatJsonlPath(chat.projectId, chatId))
  return { chat, messages }
}

export async function renameChat(chatId: string, title: string): Promise<ChatMeta> {
  const chat = await getChatMeta(chatId)
  await assertProjectContentMutable(chat.projectId)
  return mutateChatMeta(chatId, (current) => ({ ...current, title, updatedAt: nowIso() }))
}

/** 更新上下文对话的上下文范围（PRD 6.4 / 6.6）*/
export async function updateChatContext(
  chatId: string,
  contextRange: import('@shared/types').ContextRange
): Promise<ChatMeta> {
  return mutateChatMeta(chatId, (chat) => {
    if (chat.system === FEATURE_GUIDE_PROJECT_KIND) {
      throw new Error('Built-in feature guide chat cannot be modified')
    }
    return { ...chat, contextRange, updatedAt: nowIso() }
  })
}

async function mutateChatContent<T>(chatId: string, operation: () => Promise<T>): Promise<T> {
  return enqueueSerialized(`chat-content:${chatId}`, operation)
}

export async function appendMessage(chatId: string, message: ChatMessage): Promise<void> {
  await mutateChatContent(chatId, async () => {
    const chat = await getChatMeta(chatId)
    const persistedMessage = chat.system === FEATURE_GUIDE_PROJECT_KIND && message.attachments?.length
      ? { ...message, attachments: [] }
      : message
    await appendJsonl(chatJsonlPath(chat.projectId, chatId), persistedMessage)
    await mutateChatMeta(chatId, (current) => ({ ...current, updatedAt: nowIso() }))
  })
}

/** Replace the latest assistant answer and return its persisted ID. */
export async function replaceLastAssistantMessage(
  chatId: string,
  content: string,
  reasoning: string | undefined,
  memory: ChatMessage['memory']
): Promise<string | null> {
  return mutateChatContent(chatId, async () => {
    const { chat, messages } = await getChat(chatId)
    let messageId: string | null = null
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        messages[i] = { ...messages[i], content, regenerated: true, reasoning, memory }
        messageId = messages[i].id
        break
      }
    }
    await atomicWrite(chatJsonlPath(chat.projectId, chatId), messages.map((m) => JSON.stringify(m)).join('\n') + (messages.length ? '\n' : ''))
    await mutateChatMeta(chatId, (current) => ({ ...current, updatedAt: nowIso() }))
    return messageId
  })
}

/** 用户归档对话（PRD 4.2.1）*/
export async function deleteChat(chatId: string): Promise<void> {
  const chat = await getChatMeta(chatId)
  if (chat.system === FEATURE_GUIDE_PROJECT_KIND) throw new Error('Built-in feature guide chat cannot be deleted individually')
  await mutateChatMeta(chatId, (chat) => ({ ...chat, status: 'user_archived', updatedAt: nowIso() }))
}

/** 从归档区恢复对话（PRD 4.2.3）*/
export async function restoreChat(chatId: string): Promise<ChatMeta> {
  const current = await getChatMeta(chatId)
  if (current.system === FEATURE_GUIDE_PROJECT_KIND) throw new Error('Built-in feature guide chat cannot be restored individually')
  return mutateChatMeta(chatId, async (chat) => {
    // Restore the original relation when its document still exists; otherwise restore as a project chat.
    let kind: ChatKind = chat.kind
    let docId = chat.docId
    if (chat.kind === 'doc' || chat.kind === 'context') {
      const docMeta = docId ? await readJson<DocMeta>(docMetaPath(chat.projectId, docId)) : null
      if (!docMeta || docMeta.status === 'trash') {
        kind = 'project'
        docId = undefined
      }
    }
    return { ...chat, kind, docId, status: 'normal' as const, updatedAt: nowIso() }
  })
}

export async function purgeChat(chatId: string): Promise<void> {
  const chat = await getChatMeta(chatId)
  if (chat.system === FEATURE_GUIDE_PROJECT_KIND) throw new Error('Built-in feature guide chat cannot be deleted individually')
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
// 璧勬簮涓庡揩鐓?
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
  await assertProjectContentMutable(projectId)
  const sourceFormat = getResourceSourceFormat(name) ?? 'txt'
  return createResourceFiles(projectId, name, Buffer.from(content, 'utf8'), {
    content,
    sourceFormat,
    contentFormat: sourceFormat === 'md' ? 'markdown' : 'plain_text',
    warnings: [],
    encoding: {
      encoding: 'utf-8',
      confidence: 100,
      hadBom: false,
      suspicious: false,
      replacementCount: 0,
      nulCount: 0,
      controlCount: 0,
      mojibakeCount: 0
    }
  })
}

function buildResourceMeta(
  projectId: string,
  id: string,
  name: string,
  converted: ConvertedResourceInput,
  previous?: ResourceMeta,
  contentEdited = false
): ResourceMeta {
  const timestamp = nowIso()
  return {
    ...(previous ?? {}),
    id,
    projectId,
    name,
    ext: converted.sourceFormat,
    size: Buffer.byteLength(converted.content, 'utf8'),
    createdAt: previous?.createdAt ?? timestamp,
    updatedAt: timestamp,
    sourceEncoding: converted.encoding?.encoding,
    sourceEncodingConfidence: converted.encoding?.confidence,
    sourceHadBom: converted.encoding?.hadBom,
    sourceFormat: converted.sourceFormat,
    contentFormat: converted.contentFormat,
    conversionWarnings: converted.warnings,
    ...(contentEdited ? { contentEditedAt: timestamp } : { contentEditedAt: undefined })
  }
}

async function invalidateResourceDistillationCheckpoint(projectId: string, resourceId: string): Promise<void> {
  await rm(settingDistillationCheckpointPath(projectId, resourceId), { force: true })
}

async function removeResourceDerivedData(projectId: string, resourceId: string): Promise<void> {
  await rm(resourceSummaryPath(projectId, resourceId), { force: true })
  await invalidateResourceDistillationCheckpoint(projectId, resourceId)
}

const resourceCreateLocks = new Map<string, Promise<void>>()

async function createResourceFiles(
  projectId: string,
  name: string,
  data: Uint8Array,
  converted: ConvertedResourceInput,
  contentOverride?: string
): Promise<ResourceMeta> {
  const previous = resourceCreateLocks.get(projectId) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  resourceCreateLocks.set(projectId, current)
  await previous

  try {
    const finalName = uniqueResourceName(name, await listResources(projectId))
    const id = newId()
    const content = contentOverride ?? converted.content
    if (!content.trim()) throw new Error(`Resource \"${finalName}\" has no text content to save`)
    const effective = { ...converted, content }
    const meta = buildResourceMeta(projectId, id, finalName, effective, undefined, content !== converted.content)
    await atomicWrite(resourceSourcePath(projectId, id), data)
    await atomicWrite(resourceContentPath(projectId, id), content)
    await atomicWriteJson(resourceMetaPath(projectId, id), meta)
    return meta
  } finally {
    release()
    if (resourceCreateLocks.get(projectId) === current) resourceCreateLocks.delete(projectId)
  }
}


export async function uploadResourceBytes(
  projectId: string,
  name: string,
  data: Uint8Array,
  encodingHint?: string
): Promise<ResourceMeta> {
  await assertProjectContentMutable(projectId)
  const converted = await convertResourceInput(name, data, encodingHint)
  return createResourceFiles(projectId, name, data, converted)
}

export async function readResource(projectId: string, resourceId: string): Promise<{
  content: string
  name: string
  encoding: TextEncodingInfo
  meta: ResourceMeta
}> {
  const meta = await readJson<ResourceMeta>(resourceMetaPath(projectId, resourceId))
  if (!meta) throw new Error('resource not found')
  const decoded = await readDecodedTextFile(resourceContentPath(projectId, resourceId))
  return {
    content: decoded.text,
    name: meta.name,
    meta,
    encoding: {
      ...decoded.info,
      encoding: meta.sourceEncoding ?? decoded.info.encoding,
      confidence: meta.sourceEncodingConfidence ?? decoded.info.confidence,
      hadBom: meta.sourceHadBom ?? decoded.info.hadBom
    }
  }
}

async function mutateResource<T>(projectId: string, resourceId: string, operation: () => Promise<T>): Promise<T> {
  return enqueueSerialized(`resource:${projectId}:${resourceId}`, operation)
}

export async function saveResourceText(
  projectId: string,
  resourceId: string,
  content: string
): Promise<ResourceMeta> {
  return mutateResource(projectId, resourceId, async () => {
    await assertProjectContentMutable(projectId)
    assertResourceMutationAllowed(resourceId)
    const current = await readJson<ResourceMeta>(resourceMetaPath(projectId, resourceId))
    if (!current) throw new Error('resource not found')
    const timestamp = nowIso()
    const next: ResourceMeta = {
      ...current,
      size: Buffer.byteLength(content, 'utf8'),
      updatedAt: timestamp,
      contentEditedAt: timestamp
    }
    await atomicWrite(resourceContentPath(projectId, resourceId), content)
    await atomicWriteJson(resourceMetaPath(projectId, resourceId), next)
    await invalidateResourceDistillationCheckpoint(projectId, resourceId)
    return next
  })
}

export async function replaceResourceBytes(
  projectId: string,
  resourceId: string,
  data: Uint8Array,
  encodingHint?: string,
  sourceName?: string
): Promise<ResourceMeta> {
  return mutateResource(projectId, resourceId, async () => {
    await assertProjectContentMutable(projectId)
    assertResourceMutationAllowed(resourceId)
    const current = await readJson<ResourceMeta>(resourceMetaPath(projectId, resourceId))
    if (!current) throw new Error('resource not found')
    const converted = await convertResourceInput(sourceName ?? current.name, data, encodingHint)
    const next = buildResourceMeta(projectId, resourceId, current.name, converted, current, true)
    await atomicWrite(resourceSourcePath(projectId, resourceId), data)
    await atomicWrite(resourceContentPath(projectId, resourceId), converted.content)
    await atomicWriteJson(resourceMetaPath(projectId, resourceId), next)
    await invalidateResourceDistillationCheckpoint(projectId, resourceId)
    return next
  })
}

export async function deleteResource(projectId: string, resourceId: string): Promise<void> {
  await mutateResource(projectId, resourceId, async () => {
    await assertProjectContentMutable(projectId)
    assertResourceMutationAllowed(resourceId)
    await rm(resourceDir(projectId, resourceId), { recursive: true, force: true })
    await removeResourceDerivedData(projectId, resourceId)
  })
}

function assertResourceMutationAllowed(resourceId: string): void {
  if (isSummaryGenerating(`res:${resourceId}`)) {
    throw new Error('资源正在蒸馏，暂不可编辑，请等待蒸馏完成后再操作')
  }
}

function uniqueResourceName(name: string, resources: ResourceMeta[]): string {
  const used = new Set(resources.map((resource) => resource.name.toLocaleLowerCase()))
  if (!used.has(name.toLocaleLowerCase())) return name
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const suffix = dot > 0 ? name.slice(dot) : ''
  for (let index = 2; ; index += 1) {
    const candidate = `${base} (${index})${suffix}`
    if (!used.has(candidate.toLocaleLowerCase())) return candidate
  }
}

export async function importExternalResource(
  projectId: string,
  name: string,
  data: Uint8Array,
  editedContent: string,
  conflict: 'overwrite' | 'rename'
): Promise<ResourceMeta> {
  await assertProjectContentMutable(projectId)
  const converted = await convertResourceInput(name, data)
  if (!editedContent.trim()) throw new Error('外部文件没有可保存的正文内容')
  const resources = await listResources(projectId)
  const existing = resources.find((resource) => resource.name.toLocaleLowerCase() === name.toLocaleLowerCase())
  if (existing && conflict === 'overwrite') {
    return mutateResource(projectId, existing.id, async () => {
      await assertProjectContentMutable(projectId)
      assertResourceMutationAllowed(existing.id)
      const current = await readJson<ResourceMeta>(resourceMetaPath(projectId, existing.id))
      if (!current) throw new Error('resource not found')
      const effective = { ...converted, content: editedContent }
      const next = buildResourceMeta(projectId, existing.id, current.name, effective, current, true)
      await atomicWrite(resourceSourcePath(projectId, existing.id), data)
      await atomicWrite(resourceContentPath(projectId, existing.id), editedContent)
      await atomicWriteJson(resourceMetaPath(projectId, existing.id), next)
      await invalidateResourceDistillationCheckpoint(projectId, existing.id)
      return next
    })
  }
  return createResourceFiles(projectId, name, data, converted, editedContent)
}

/** Read and normalize an associated file without adding it to any project. */
export async function importExternalFile(filePath: string): Promise<{
  ok: boolean
  error?: string
  name?: string
  path?: string
  content?: string
  data?: Uint8Array
  sourceFormat?: import('@shared/resource-formats').ResourceSourceFormat
  contentFormat?: import('@shared/resource-formats').ResourceContentFormat
  warnings?: string[]
}> {
  if (!isSupportedResourceFile(filePath)) {
    return { ok: false, error: '不支持的文件类型，仅支持 .txt / .md / .csv / .doc / .docx' }
  }
  const name = basename(filePath)
  try {
    const bytes = await readFile(filePath)
    const converted = await convertResourceInput(name, bytes)
    return {
      ok: true,
      name,
      path: filePath,
      content: converted.content,
      data: new Uint8Array(bytes),
      sourceFormat: converted.sourceFormat,
      contentFormat: converted.contentFormat,
      warnings: converted.warnings
    }
  } catch (err) {
    return { ok: false, error: `无法读取文件：${(err as Error).message}` }
  }
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
  source: { mode: 'resource'; resourceId: string } | { mode: 'local'; name: string; data: Uint8Array; encodingHint?: string }
): Promise<UploadResult> {
  const chat = await getChatMeta(chatId)
  if (chat.projectId !== projectId) throw new Error('chat does not belong to project')
  await assertProjectContentMutable(chat.projectId)
  if (chat.system === FEATURE_GUIDE_PROJECT_KIND) {
    throw new Error('Built-in feature guide chat cannot accept attachments')
  }
  let resource: ResourceMeta
  let content: string
  let name: string
  let resourceId: string | undefined

  if (source.mode === 'local') {
    resource = await uploadResourceBytes(projectId, source.name, source.data, source.encodingHint)
    const uploaded = await readResource(projectId, resource.id)
    content = uploaded.content
    name = uploaded.name
    resourceId = resource.id
  } else {
    const res = await readResource(projectId, source.resourceId)
    assertTextIntegrity(res.encoding, res.name)
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

/** 读取文档摘要；仅接受当前 schema，旧格式视为未生成。*/
export async function readDocSummary(projectId: string, docId: string): Promise<DocSummary | null> {
  const s = await readJson<DocSummary>(docSummaryPath(projectId, docId))
  if (!s || s.schemaVersion !== SUMMARY_SCHEMA_VERSION) return null
  if (!Array.isArray(s.characters) || !s.knowledge || !s.generation || !Array.isArray(s.chunkResults)) return null
  return s
}

export async function writeDocSummary(projectId: string, docId: string, summary: DocSummary): Promise<void> {
  await atomicWriteJson(docSummaryPath(projectId, docId), summary)
}

/** 读取对话摘要；旧格式（单标签版）视为无摘要，触发重新生成 */
export async function readChatSummary(projectId: string, chatId: string): Promise<ChatSummary | null> {
  const s = await readJson<ChatSummary>(chatSummaryPath(projectId, chatId))
  // A chat summary is incremental data, so an old single-list format or a
  // partially written file must be rebuilt rather than silently reused.
  if (!s || !Array.isArray(s.items) || !Array.isArray(s.compacted)) return null
  if (typeof s.lastMessageId !== 'string' || !Number.isInteger(s.messageCount) || s.messageCount < 0) return null
  return s
}

export async function writeChatSummary(projectId: string, chatId: string, summary: ChatSummary): Promise<void> {
  await atomicWriteJson(chatSummaryPath(projectId, chatId), summary)
}

export async function readResourceSummary(projectId: string, resourceId: string): Promise<ResourceSummary | null> {
  const s = await readJson<ResourceSummary>(resourceSummaryPath(projectId, resourceId))
  if (!s || s.schemaVersion !== SUMMARY_SCHEMA_VERSION) return null
  if (!s.knowledge || !s.generation || !Array.isArray(s.chunkResults)) return null
  return s
}

export async function writeResourceSummary(projectId: string, resourceId: string, summary: ResourceSummary): Promise<void> {
  await atomicWriteJson(resourceSummaryPath(projectId, resourceId), summary)
}

export async function removeResourceSummary(projectId: string, resourceId: string): Promise<void> {
  await rm(resourceSummaryPath(projectId, resourceId), { force: true })
  await removeSettingDistillationCheckpoint(projectId, resourceId)
}

export async function readSettingDistillationCheckpoint<T>(projectId: string, resourceId: string): Promise<T | null> {
  return readJson<T>(settingDistillationCheckpointPath(projectId, resourceId))
}

export async function writeSettingDistillationCheckpoint<T>(projectId: string, resourceId: string, checkpoint: T): Promise<void> {
  await atomicWriteJson(settingDistillationCheckpointPath(projectId, resourceId), checkpoint)
}

export async function removeSettingDistillationCheckpoint(projectId: string, resourceId: string): Promise<void> {
  await rm(settingDistillationCheckpointPath(projectId, resourceId), { force: true })
}

export async function readDocRollups(projectId: string): Promise<DocRollup[]> {
  const data = await readJson<{ rollups: DocRollup[] }>(rollupsPath(projectId))
  return Array.isArray(data?.rollups) ? data.rollups : []
}

export async function writeDocRollups(projectId: string, rollups: DocRollup[]): Promise<void> {
  await atomicWriteJson(rollupsPath(projectId), { rollups })
}

export async function readVectorIndex(projectId: string): Promise<VectorIndex | null> {
  return readJson<VectorIndex>(vectorIndexPath(projectId))
}

export async function writeVectorIndex(projectId: string, index: VectorIndex): Promise<void> {
  await atomicWriteJson(vectorIndexPath(projectId), index)
}

// ---------------------------------------------------------------------------
// 宸ヤ綔鍖哄揩鐓?
// ---------------------------------------------------------------------------

async function buildProjectTree(p: ProjectMeta): Promise<ProjectTree> {
  const docs = await listDocMetas(p.id)
  const orderedDocs = p.system === FEATURE_GUIDE_PROJECT_KIND
    ? [...docs].sort((a, b) => (a.systemOrder ?? Number.MAX_SAFE_INTEGER) - (b.systemOrder ?? Number.MAX_SAFE_INTEGER))
    : docs
  const chats = await listChatMetas(p.id)
  const resources = await listResources(p.id)
  return {
    project: p,
    docs: orderedDocs.filter((d) => d.status === 'normal'),
    chats: chats.filter((c) => c.status === 'normal'),
    resources,
    archivedChats: chats.filter((c) => c.status === 'user_archived' || c.status === 'orphan_archived'),
    trashedDocs: orderedDocs.filter((d) => d.status === 'trash')
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
