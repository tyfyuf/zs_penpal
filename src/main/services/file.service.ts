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
import { appendJsonl, atomicWrite, atomicWriteJson, newId, nowIso, readJson, readJsonl } from '../util'
import { computeSourceInfo, SUMMARY_SCHEMA_VERSION } from '../summary-source'
import { assertTextIntegrity, readDecodedTextFile } from './text-decoding.service'
import { convertResourceInput, type ConvertedResourceInput } from './resource-conversion.service'
import { getResourceSourceFormat, isSupportedResourceFile } from '@shared/resource-formats'
import { isSummaryGenerating } from './summary-state.service'

// ---------------------------------------------------------------------------
// 鐩綍缁撴瀯锛堜緷鎹?tech-stack 7.2锛岀敓鍛藉懆鏈熺姸鎬佸瓨浜庡厓鏁版嵁 JSON锛屼笉渚濊禆鐩綍绉诲姩锛?
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
// 宸ヤ綔鐩綍绱㈠紩
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
  // 鍚屾鍐欏叆椤圭洰鐩綍 meta.json锛屼緵 Git 璺熻釜
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

export async function setProjectSummaryAutoMaintenance(projectId: string, enabled: boolean): Promise<ProjectMeta> {
  return mutateProject(projectId, { summaryAutoMaintenance: enabled })
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
// 鏂囨。
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
  // 鏂板缓鏂囨。锛歎TF-8锛岀┖鍐呭锛圠F锛?
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

/** 璺ㄩ」鐩煡鎵炬枃妗ｅ厓鏁版嵁锛堢敤浜?readDoc 绛夋寜 id 瀹氫綅鐨勫満鏅級 */
export async function findDocMeta(docId: string): Promise<DocMeta> {
  const projects = await listProjects()
  for (const p of projects) {
    const meta = await readJson<DocMeta>(docMetaPath(p.id, docId))
    if (meta) return meta
  }
  throw new Error('doc not found')
}

export async function saveDoc(docId: string, content: string, editorFormat?: DocEditorFormat): Promise<void> {
  const doc = await findDocMeta(docId)
  await atomicWrite(docContentPath(doc.projectId, docId), content)
  const meta = await getDocMeta(doc.projectId, docId)
  const next: DocMeta = {
    ...meta,
    ...(editorFormat === undefined ? {} : { editorFormat }),
    updatedAt: nowIso()
  }
  await atomicWriteJson(docMetaPath(doc.projectId, docId), next)
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
 * 褰诲簳鍒犻櫎鏂囨。锛圥RD 4.1.3 / 4.1.5锛夛細
 * - 鏂囨。鏈綋 + 鏂囨。鎽樿鍒犻櫎
 * - 浠嶅叧鑱旂殑鏂囨。绾у璇?鈫?瀛ゅ効褰掓。
 * - 宸茶鐢ㄦ埛鍗曠嫭褰掓。鐨勬枃妗ｇ骇瀵硅瘽 鈫?涓€骞剁Щ闄?
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
      await mutateChatMeta(chat.id, (current) => ({
        ...current,
        status: 'orphan_archived',
        updatedAt: nowIso()
      }))
    }
  }
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

/** 鏇存柊瀵硅瘽 meta 鐨勫彲鍙樺瓧娈碉紙contextRange / lockedRange / injectionOverrides锛?*/
export async function updateChatMeta(
  chatId: string,
  patch: Partial<Pick<ChatMeta, 'contextRange' | 'lockedRange' | 'injectionOverrides' | 'summaryLearning'>>
): Promise<ChatMeta> {
  return mutateChatMeta(chatId, (chat) => ({ ...chat, ...patch, updatedAt: nowIso() }))
}

export async function getChat(chatId: string): Promise<{ chat: ChatMeta; messages: ChatMessage[] }> {
  const chat = await getChatMeta(chatId)
  const messages = await readJsonl<ChatMessage>(chatJsonlPath(chat.projectId, chatId))
  return { chat, messages }
}

export async function renameChat(chatId: string, title: string): Promise<ChatMeta> {
  return mutateChatMeta(chatId, (chat) => ({ ...chat, title, updatedAt: nowIso() }))
}

/** 鏇存柊涓婁笅鏂囧璇濈殑涓婁笅鏂囪寖鍥达紙PRD 6.4 / 6.6锛?*/
export async function updateChatContext(
  chatId: string,
  contextRange: import('@shared/types').ContextRange
): Promise<ChatMeta> {
  return mutateChatMeta(chatId, (chat) => ({ ...chat, contextRange, updatedAt: nowIso() }))
}

export async function appendMessage(chatId: string, message: ChatMessage): Promise<void> {
  const chat = await getChatMeta(chatId)
  await appendJsonl(chatJsonlPath(chat.projectId, chatId), message)
  await mutateChatMeta(chatId, (current) => ({ ...current, updatedAt: nowIso() }))
}

/** Replace the latest assistant answer and return its persisted ID. */
export async function replaceLastAssistantMessage(
  chatId: string,
  content: string,
  reasoning: string | undefined,
  memory: ChatMessage['memory']
): Promise<string | null> {
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
}

/** 鐢ㄦ埛褰掓。瀵硅瘽锛圥RD 4.2.1锛?*/
export async function deleteChat(chatId: string): Promise<void> {
  await mutateChatMeta(chatId, (chat) => ({ ...chat, status: 'user_archived', updatedAt: nowIso() }))
}

/** 浠庡綊妗ｅ尯鎭㈠瀵硅瘽锛圥RD 4.2.3锛?*/
export async function restoreChat(chatId: string): Promise<ChatMeta> {
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
  await rm(chatMetaPath(chat.projectId, chatId), { force: true })
  await rm(chatJsonlPath(chat.projectId, chatId), { force: true })
  await rm(chatSummaryPath(chat.projectId, chatId), { force: true })
  // 鍒犻櫎璇ュ璇濈殑蹇収鏂囦欢
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

export async function saveResourceText(
  projectId: string,
  resourceId: string,
  content: string
): Promise<ResourceMeta> {
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
}

export async function replaceResourceBytes(
  projectId: string,
  resourceId: string,
  data: Uint8Array,
  encodingHint?: string,
  sourceName?: string
): Promise<ResourceMeta> {
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
}

export async function deleteResource(projectId: string, resourceId: string): Promise<void> {
  assertResourceMutationAllowed(resourceId)
  await rm(resourceDir(projectId, resourceId), { recursive: true, force: true })
  await removeResourceDerivedData(projectId, resourceId)
}

function assertResourceMutationAllowed(resourceId: string): void {
  if (isSummaryGenerating(`res:${resourceId}`)) {
    throw new Error('璧勬簮姝ｅ湪钂搁锛屾殏涓嶅彲缂栬緫锛岃绛夊緟钂搁瀹屾垚鍚庡啀鎿嶄綔')
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
  const converted = await convertResourceInput(name, data)
  if (!editedContent.trim()) throw new Error('澶栭儴鏂囦欢娌℃湁鍙繚瀛樼殑姝ｆ枃鍐呭')
  const resources = await listResources(projectId)
  const existing = resources.find((resource) => resource.name.toLocaleLowerCase() === name.toLocaleLowerCase())
  if (existing && conflict === 'overwrite') {
    assertResourceMutationAllowed(existing.id)
    const effective = { ...converted, content: editedContent }
    const next = buildResourceMeta(projectId, existing.id, existing.name, effective, existing, true)
    await atomicWrite(resourceSourcePath(projectId, existing.id), data)
    await atomicWrite(resourceContentPath(projectId, existing.id), editedContent)
    await atomicWriteJson(resourceMetaPath(projectId, existing.id), next)
    await invalidateResourceDistillationCheckpoint(projectId, existing.id)
    return next
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
    return { ok: false, error: '涓嶆敮鎸佺殑鏂囦欢绫诲瀷锛屼粎鏀寔 .txt / .md / .csv / .doc / .docx' }
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
    return { ok: false, error: `鏃犳硶璇诲彇鏂囦欢锛?{(err as Error).message}` }
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
 * 鎶婅祫婧愬唴瀹逛互鈥滀笂浼犳椂蹇収鈥濆啓鍏ュ璇濆唴閮紙PRD 5.5 / 9.16锛夈€?
 * 鍘嗗彶浼氳瘽寮曠敤璇ュ揩鐓э紝鍚庣画淇敼/鍒犻櫎鍘熻祫婧愪笉褰卞搷浼氳瘽銆?
 */
export async function attachResourceSnapshot(
  chatId: string,
  projectId: string,
  source: { mode: 'resource'; resourceId: string } | { mode: 'local'; name: string; data: Uint8Array; encodingHint?: string }
): Promise<UploadResult> {
  const chat = await getChatMeta(chatId)
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
// 鎽樿璇诲啓
// ---------------------------------------------------------------------------

/** 璇诲彇鏂囨。鎽樿锛涗粎鎺ュ彈褰撳墠 schema锛屾棫鏍煎紡瑙嗕负鏈敓鎴愩€?*/
export async function readDocSummary(projectId: string, docId: string): Promise<DocSummary | null> {
  const s = await readJson<DocSummary>(docSummaryPath(projectId, docId))
  if (!s || s.schemaVersion !== SUMMARY_SCHEMA_VERSION) return null
  if (!Array.isArray(s.characters) || !s.knowledge || !s.generation || !Array.isArray(s.chunkResults)) return null
  return s
}

export async function writeDocSummary(projectId: string, docId: string, summary: DocSummary): Promise<void> {
  await atomicWriteJson(docSummaryPath(projectId, docId), summary)
}

/** 璇诲彇瀵硅瘽鎽樿锛涙棫鏍煎紡锛堝崟鏍囩鐗堬級瑙嗕负鏃犳憳瑕侊紝瑙﹀彂閲嶆柊鐢熸垚 */
export async function readChatSummary(projectId: string, chatId: string): Promise<ChatSummary | null> {
  const s = await readJson<ChatSummary>(chatSummaryPath(projectId, chatId))
  if (!s || !Array.isArray(s.items)) return null
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
