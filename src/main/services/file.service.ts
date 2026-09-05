import { dirname, isAbsolute, join, relative } from 'path'
import { basename } from 'path'
import { access, mkdir, readdir, readFile, rename, rm } from 'fs/promises'
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
import { withSummaryProjectQuiesced } from './summary-job-manager'

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

function isAppIndex(value: unknown): value is AppIndex {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<AppIndex>
  return Array.isArray(candidate.projects) && candidate.projects.every((project) => (
    !!project
    && typeof project === 'object'
    && typeof (project as ProjectMeta).id === 'string'
    && typeof (project as ProjectMeta).status === 'string'
  ))
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


async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function moveIfExists(source: string, target: string): Promise<boolean> {
  if (!(await pathExists(source))) return false
  await mkdir(dirname(target), { recursive: true })
  await rename(source, target)
  return true
}

async function restoreMovedFiles(
  moved: Array<{ source: string; target: string }>,
  replaceSources: ReadonlySet<string> = new Set()
): Promise<void> {
  for (const item of [...moved].reverse()) {
    if (!(await pathExists(item.target))) continue
    if (await pathExists(item.source)) {
      if (replaceSources.has(item.source)) {
        // The operation may have rewritten a live metadata file after its
        // original copy was staged. Restore the staged copy for rollback.
        await rm(item.source, { recursive: true, force: true })
        await mkdir(dirname(item.source), { recursive: true })
        await rename(item.target, item.source)
      } else {
        // If both copies exist, preserve the live source. This can happen when
        // recovery observes a process exit between rename and manifest update.
        await rm(item.target, { recursive: true, force: true })
      }
      continue
    }
    await mkdir(dirname(item.source), { recursive: true })
    await rename(item.target, item.source)
  }
}

export async function withProjectWriteLock<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
  return enqueueSerialized(`project-lifecycle:${projectId}`, operation)
}

async function withProjectLifecycle<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
  return withSummaryProjectQuiesced(projectId, () => withProjectWriteLock(projectId, operation))
}

function projectPurgeStagePrefix(projectId: string): string {
  return `.penpal-project-purge-${projectId}-`
}

function entityPurgeStagePrefix(kind: 'doc' | 'chat' | 'resource', entityId: string): string {
  return `.penpal-${kind}-purge-${entityId}-`
}

interface PurgeMove {
  source: string
  target: string
}

interface PurgeManifest {
  version: 1
  projectId: string
  state: 'moving' | 'moved' | 'committed'
  moved: Array<{ source: string; target: string }>
  /** Files rewritten during the operation must prefer the staged copy on rollback. */
  replaceSourcesOnRestore?: string[]
}

interface ProjectPurgeManifest {
  version: 1
  projectId: string
  state: 'moving' | 'moved' | 'committed'
}

async function writePurgeManifest(stage: string, manifest: PurgeManifest): Promise<void> {
  await atomicWriteJson(join(stage, 'manifest.json'), manifest)
}

async function runStagedPurge<T>(
  projectId: string,
  stage: string,
  planned: PurgeMove[],
  operation: (stage: string) => Promise<T>,
  replaceSourcesOnRestore: string[] = []
): Promise<T> {
  await mkdir(stage, { recursive: true })
  const manifest: PurgeManifest = {
    version: 1,
    projectId,
    state: 'moving',
    moved: [],
    ...(replaceSourcesOnRestore.length > 0 ? { replaceSourcesOnRestore } : {})
  }
  await writePurgeManifest(stage, manifest)
  try {
    for (const item of planned) {
      if (await moveIfExists(item.source, item.target)) {
        manifest.moved.push({ source: item.source, target: item.target })
        // Persist after every rename so startup recovery knows which files
        // actually moved instead of treating the whole plan as moved.
        await writePurgeManifest(stage, manifest)
      }
    }
    manifest.state = 'moved'
    await writePurgeManifest(stage, manifest)
    const result = await operation(stage)
    manifest.state = 'committed'
    await writePurgeManifest(stage, manifest)
    // Once the committed marker is durable, the delete is complete. Stage
    // cleanup is only best-effort; a cleanup failure must not re-enter the
    // rollback path and restore data that the index already removed. Startup
    // recovery will retry removing the committed stage.
    await rm(stage, { recursive: true, force: true }).catch(() => {})
    return result
  } catch (error) {
    // If rollback itself fails, keep the manifest and stage for startup
    // recovery instead of deleting the only remaining copy of the files.
    let restored = true
    try {
      await restoreMovedFiles(manifest.moved, new Set(manifest.replaceSourcesOnRestore ?? []))
    } catch {
      restored = false
    }
    if (restored) await rm(stage, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

function stageTarget(stage: string, filePath: string, projectId: string): string {
  const rel = relative(projectDir(projectId), filePath)
  if (!rel || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) {
    throw new Error('purge target must stay inside the project directory')
  }
  return join(stage, rel)
}

async function removeVectorSourceFromIndex(projectId: string, id: string, kind: 'doc' | 'res', indexFile = vectorIndexPath(projectId)): Promise<void> {
  const index = await readJson<VectorIndex>(indexFile)
  if (!index) return
  const chunks = Array.isArray(index.chunks)
    ? index.chunks.filter((chunk) => !(chunk.docId === id && chunk.kind === kind))
    : []
  const sources = Array.isArray(index.sources)
    ? index.sources.filter((source) => !(source.id === id && source.kind === kind))
    : index.sources
  await atomicWriteJson(indexFile, { ...index, chunks, sources, updatedAt: nowIso() })
}

async function removeDocFromRollups(projectId: string, docId: string, rollupFile = rollupsPath(projectId)): Promise<void> {
  const data = await readJson<{ rollups: DocRollup[] }>(rollupFile)
  const rollups = Array.isArray(data?.rollups) ? data.rollups : []
  const next = rollups
    .filter((rollup) => !rollup.docIds.includes(docId))
    .map((rollup) => {
      const sourceFingerprints = { ...rollup.sourceFingerprints }
      delete sourceFingerprints[docId]
      return { ...rollup, sourceFingerprints }
    })
  const changed = JSON.stringify(next) !== JSON.stringify(rollups)
  if (changed) await atomicWriteJson(rollupFile, { rollups: next })
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
  try {
    const raw = await readFile(indexPath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!isAppIndex(parsed)) throw new Error('workspace index is invalid')
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, projects: [], featureGuideInitialized: false }
    }
    throw error
  }
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
  if (!project) throw new Error('project not found')
  if (project.status !== 'normal') throw new Error('project is not active')
  if (project.system === FEATURE_GUIDE_PROJECT_KIND) {
    throw new Error('Built-in feature guide content cannot be modified individually')
  }
}

/**
 * Summary jobs run asynchronously and may finish after their source was
 * deleted, archived, or moved to another project. Keep the ownership and
 * lifecycle check in the file service, immediately next to the canonical
 * metadata paths, so every derived-data write uses the same rules.
 */
export async function assertSummaryProjectActive(projectId: string): Promise<void> {
  const project = await projectMetaById(projectId)
  if (!project) throw new Error('summary project not found')
  if (project.status !== 'normal') throw new Error('summary project is not active')
}

export async function assertSummaryEntityActive(
  projectId: string,
  kind: 'doc' | 'chat' | 'resource',
  entityId: string
): Promise<void> {
  await assertSummaryProjectActive(projectId)
  if (kind === 'doc') {
    const meta = await readJson<DocMeta>(docMetaPath(projectId, entityId))
    if (!meta || meta.projectId !== projectId) throw new Error('summary document does not belong to project')
    if (meta.status !== 'normal') throw new Error('summary document is not active')
    return
  }
  if (kind === 'chat') {
    const meta = await readJson<ChatMeta>(chatMetaPath(projectId, entityId))
    if (!meta || meta.projectId !== projectId) throw new Error('summary chat does not belong to project')
    if (meta.status !== 'normal') throw new Error('summary chat is not active')
    return
  }
  const meta = await readJson<ResourceMeta>(resourceMetaPath(projectId, entityId))
  if (!meta || meta.projectId !== projectId) throw new Error('summary resource does not belong to project')
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

async function removeProjectPurgeStage(stage: string, manifestPath: string): Promise<boolean> {
  try {
    await rm(stage, { recursive: true, force: true })
    await rm(manifestPath, { force: true })
    return true
  } catch {
    // Keep the sidecar whenever cleanup is incomplete so the next startup can
    // retry without losing the only recovery record.
    return false
  }
}

async function recoverProjectPurgeStages(): Promise<void> {
  const idx = await loadIndex()
  const root = wsRoot()
  let entries: string[] = []
  try {
    entries = await readdir(root)
  } catch {
    return
  }

  const handledStages = new Set<string>()
  const manifestSuffix = '.manifest.json'

  // New project purges use a sidecar manifest because the whole project
  // directory is renamed at once and cannot contain a manifest beforehand.
  for (const entry of entries) {
    if (!entry.startsWith('.penpal-project-purge-') || !entry.endsWith(manifestSuffix)) continue
    const manifestPath = join(root, entry)
    const stageEntry = entry.slice(0, -manifestSuffix.length)
    const stage = join(root, stageEntry)
    const manifest = await readJson<ProjectPurgeManifest>(manifestPath)
    if (!manifest || manifest.version !== 1 || typeof manifest.projectId !== 'string') continue
    if (!stageEntry.startsWith(projectPurgeStagePrefix(manifest.projectId))) continue

    const source = projectDir(manifest.projectId)
    const stillIndexed = idx.projects.some((project) => project.id === manifest.projectId)
    const sourceExists = await pathExists(source)
    const stageExists = await pathExists(stage)
    let resolved = false

    if (stillIndexed) {
      if (sourceExists) {
        // The indexed project is authoritative. A leftover stage is safe to
        // discard only after the live project directory is confirmed present.
        resolved = await removeProjectPurgeStage(stage, manifestPath)
      } else if (stageExists) {
        // Prefer the reliable index over a stale committed marker: never leave
        // an indexed project without its directory.
        try {
          await rename(stage, source)
          resolved = await pathExists(source)
          if (resolved) await rm(manifestPath, { force: true })
        } catch {
          resolved = false
        }
      }
    } else {
      // A valid index that no longer contains the project confirms the purge.
      // If cleanup fails, keep the sidecar for the next startup.
      resolved = await removeProjectPurgeStage(stage, manifestPath)
    }

    if (resolved) handledStages.add(stageEntry)
  }

  // Recover stages created by the earlier implementation, which had no
  // sidecar manifest. Never guess an unknown project ID from a delimiter;
  // prefer staged meta.json or an exact known-project prefix.
  for (const entry of entries) {
    if (!entry.startsWith('.penpal-project-purge-') || entry.endsWith(manifestSuffix) || handledStages.has(entry)) continue
    const stage = join(root, entry)
    const stagedMeta = await readJson<ProjectMeta>(join(stage, 'meta.json'))
    const candidates = idx.projects
      .filter((project) => entry.startsWith(projectPurgeStagePrefix(project.id)))
      .sort((a, b) => b.id.length - a.id.length)
    const projectId = stagedMeta?.id ?? candidates[0]?.id
    if (!projectId) continue

    const source = projectDir(projectId)
    if (idx.projects.some((project) => project.id === projectId)) {
      if (!(await pathExists(source)) && await pathExists(stage)) await rename(stage, source).catch(() => {})
      else if (await pathExists(source)) await rm(stage, { recursive: true, force: true }).catch(() => {})
    } else {
      await rm(stage, { recursive: true, force: true }).catch(() => {})
    }
  }
}

async function recoverEntityPurgeStages(): Promise<void> {
  const idx = await loadIndex()
  for (const project of idx.projects) {
    const root = projectDir(project.id)
    let entries: string[] = []
    try {
      entries = await readdir(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.startsWith('.penpal-doc-purge-') && !entry.startsWith('.penpal-chat-purge-') && !entry.startsWith('.penpal-resource-purge-')) continue
      const stage = join(root, entry)
      const manifest = await readJson<PurgeManifest>(join(stage, 'manifest.json'))
      if (!manifest || manifest.projectId !== project.id || !Array.isArray(manifest.moved)) {
        // An unreadable or foreign manifest may be the only record of files
        // that were moved before the process exited. Preserve the stage so a
        // later recovery or manual inspection can recover it safely.
        continue
      }
      if (manifest.state === 'committed') {
        await rm(stage, { recursive: true, force: true }).catch(() => {})
      } else {
        try {
          await restoreMovedFiles(manifest.moved, new Set(manifest.replaceSourcesOnRestore ?? []))
          await rm(stage, { recursive: true, force: true })
        } catch {
          // Keep both the manifest and staged copies when recovery is partial.
          // Deleting them here could permanently lose the only remaining copy.
        }
      }
    }
  }
}

export async function ensureWorkspace(): Promise<void> {
  const root = wsRoot()
  await mkdir(root, { recursive: true })
  await mkdir(indexPath().replace('app-index.json', ''), { recursive: true })
  try {
    await access(indexPath())
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await saveIndex({ version: 1, projects: [], featureGuideInitialized: false })
  }
  await recoverProjectPurgeStages()
  await recoverEntityPurgeStages()
}

async function mutateProject(projectId: string, patch: Partial<ProjectMeta>): Promise<ProjectMeta> {
  return enqueueSerialized('workspace-project-index', async () => {
    const idx = await loadIndex()
    const i = idx.projects.findIndex((p) => p.id === projectId)
    if (i < 0) throw new Error('project not found')
    idx.projects[i] = { ...idx.projects[i], ...patch, updatedAt: nowIso() }
    await saveIndex(idx)
    // Keep the project metadata file in sync with the workspace index.
    await atomicWriteJson(join(projectDir(projectId), 'meta.json'), idx.projects[i])
    return idx.projects[i]
  })
}

// ---------------------------------------------------------------------------
// 项目
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
  await withProjectLifecycle(projectId, async () => {
    await mutateProject(projectId, { status: 'trash' })
  })
}

export async function restoreProject(projectId: string): Promise<ProjectMeta> {
  return withProjectLifecycle(projectId, async () => {
    const project = await projectMetaById(projectId)
    if (project?.system === FEATURE_GUIDE_PROJECT_KIND) {
      throw new Error('Built-in feature guide project can only be restored from Settings')
    }
    return mutateProject(projectId, { status: 'normal' })
  })
}

export async function purgeProject(projectId: string): Promise<void> {
  await withProjectLifecycle(projectId, async () => {
    await enqueueSerialized('workspace-project-index', async () => {
      const idx = await loadIndex()
      if (!idx.projects.some((project) => project.id === projectId)) throw new Error('project not found')

      const source = projectDir(projectId)
      const stage = join(wsRoot(), `${projectPurgeStagePrefix(projectId)}${newId()}`)
      const manifestPath = `${stage}.manifest.json`
      const manifest: ProjectPurgeManifest = { version: 1, projectId, state: 'moving' }
      await atomicWriteJson(manifestPath, manifest)
      let moved = false
      try {
        await rename(source, stage)
        moved = true
        manifest.state = 'moved'
        await atomicWriteJson(manifestPath, manifest)

        idx.projects = idx.projects.filter((project) => project.id !== projectId)
        await saveIndex(idx)

        manifest.state = 'committed'
        await atomicWriteJson(manifestPath, manifest)
        try {
          await rm(stage, { recursive: true, force: true })
          await rm(manifestPath, { force: true })
        } catch {
          // Keep the sidecar if cleanup is incomplete; startup recovery can
          // safely retry it because the index commit is already durable.
        }
      } catch (error) {
        let latest: AppIndex
        try {
          latest = await loadIndex()
        } catch {
          // An unreadable index leaves the commit state unknown. Preserve the
          // sidecar and staged directory for startup recovery.
          throw error
        }
        const stillIndexed = latest.projects.some((project) => project.id === projectId)
        if (stillIndexed && moved) {
          try {
            await restoreMovedFiles([{ source, target: stage }])
            await rm(manifestPath, { force: true }).catch(() => {})
          } catch {
            // Keep the sidecar and staged directory for startup recovery.
          }
        } else if (!stillIndexed) {
          // The valid index commit succeeded; never resurrect a project that
          // is no longer indexed, even if manifest update or cleanup failed.
          try {
            await rm(stage, { recursive: true, force: true })
            await rm(manifestPath, { force: true })
          } catch {
            // Keep the sidecar if cleanup is incomplete.
          }
        }
        throw error
      }
    })
  })
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
  return withProjectWriteLock(projectId, async () => {
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
    await atomicWrite(docContentPath(projectId, id), '')
    return meta
  })
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

export async function readDocForSummary(projectId: string, docId: string): Promise<{ doc: DocMeta; content: string }> {
  await assertSummaryEntityActive(projectId, 'doc', docId)
  const doc = await getDocMeta(projectId, docId)
  const { text: content } = await readDecodedTextFile(docContentPath(projectId, docId))
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
  const doc = await findDocMeta(docId)
  await withProjectWriteLock(doc.projectId, () => mutateDocument(docId, async () => {
    const currentDoc = await findDocMeta(docId)
    await assertProjectContentMutable(currentDoc.projectId)
    await atomicWrite(docContentPath(currentDoc.projectId, docId), content)
    const meta = await getDocMeta(currentDoc.projectId, docId)
    const next: DocMeta = {
      ...meta,
      ...(editorFormat === undefined ? {} : { editorFormat }),
      updatedAt: nowIso()
    }
    await atomicWriteJson(docMetaPath(currentDoc.projectId, docId), next)
  }))
}


export async function renameDoc(docId: string, title: string): Promise<DocMeta> {
  const doc = await findDocMeta(docId)
  return withProjectWriteLock(doc.projectId, () => mutateDocument(docId, async () => {
    const currentDoc = await findDocMeta(docId)
    await assertProjectContentMutable(currentDoc.projectId)
    const meta = await getDocMeta(currentDoc.projectId, docId)
    const next = { ...meta, title, updatedAt: nowIso() }
    await atomicWriteJson(docMetaPath(currentDoc.projectId, docId), next)
    return next
  }))
}


export async function deleteDoc(docId: string): Promise<void> {
  const doc = await findDocMeta(docId)
  await withProjectLifecycle(doc.projectId, () => mutateDocument(docId, async () => {
    const current = await findDocMeta(docId)
    await assertProjectContentMutable(current.projectId)
    const meta = await getDocMeta(current.projectId, docId)
    await atomicWriteJson(docMetaPath(current.projectId, docId), { ...meta, status: 'trash', updatedAt: nowIso() })
    for (const chat of await listChatMetas(current.projectId)) {
      if (chat.docId !== docId || chat.status !== 'normal') continue
      await atomicWriteJson(chatMetaPath(current.projectId, chat.id), { ...chat, status: 'orphan_archived', updatedAt: nowIso() })
    }
  }))
}

export async function restoreDoc(docId: string): Promise<DocMeta> {
  const doc = await findDocMeta(docId)
  return withProjectLifecycle(doc.projectId, () => mutateDocument(docId, async () => {
    const current = await findDocMeta(docId)
    await assertProjectContentMutable(current.projectId)
    const meta = await getDocMeta(current.projectId, docId)
    const next: DocMeta = { ...meta, status: 'normal', updatedAt: nowIso() }
    await atomicWriteJson(docMetaPath(current.projectId, docId), next)
    for (const chat of await listChatMetas(current.projectId)) {
      if (chat.docId !== docId || chat.status !== 'orphan_archived') continue
      await atomicWriteJson(chatMetaPath(current.projectId, chat.id), { ...chat, status: 'normal', updatedAt: nowIso() })
    }
    return next
  }))
}

async function chatArtifactPaths(projectId: string, chatId: string): Promise<string[]> {
  const paths = [chatMetaPath(projectId, chatId), chatJsonlPath(projectId, chatId), chatSummaryPath(projectId, chatId)]
  let entries: string[] = []
  try { entries = await readdir(chatsDir(projectId)) } catch { return paths }
  return [...paths, ...entries.filter((name) => name.startsWith(`${chatId}.snap-`)).map((name) => join(chatsDir(projectId), name))]
}

export async function purgeDoc(docId: string): Promise<void> {
  const doc = await findDocMeta(docId)
  await withProjectLifecycle(doc.projectId, async () => {
    const projectId = doc.projectId
    await assertProjectContentMutable(projectId)
    const chats = (await listChatMetas(projectId)).filter((chat) => chat.docId === docId)
    const stage = join(projectDir(projectId), `${entityPurgeStagePrefix('doc', docId)}${newId()}`)
    const sources = [
      docMetaPath(projectId, docId),
      docContentPath(projectId, docId),
      docSummaryPath(projectId, docId),
      vectorIndexPath(projectId),
      rollupsPath(projectId)
    ]
    for (const chat of chats) {
      if (chat.status === 'user_archived') sources.push(...await chatArtifactPaths(projectId, chat.id))
      else if (chat.status === 'normal') sources.push(chatMetaPath(projectId, chat.id))
    }
    const planned = sources.map((source) => ({ source, target: stageTarget(stage, source, projectId) }))
    const replaceSourcesOnRestore = chats
      .filter((chat) => chat.status === 'normal')
      .map((chat) => chatMetaPath(projectId, chat.id))
    await runStagedPurge(projectId, stage, planned, async () => {
      for (const chat of chats) {
        if (chat.status !== 'normal') continue
        await atomicWriteJson(chatMetaPath(projectId, chat.id), { ...chat, status: 'orphan_archived', updatedAt: nowIso() })
      }
      await removeVectorSourceFromIndex(projectId, docId, 'doc', stageTarget(stage, vectorIndexPath(projectId), projectId))
      await removeDocFromRollups(projectId, docId, stageTarget(stage, rollupsPath(projectId), projectId))
    }, replaceSourcesOnRestore)
  })
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

async function getChatMetaInProject(projectId: string, chatId: string): Promise<ChatMeta> {
  const meta = await readJson<ChatMeta>(chatMetaPath(projectId, chatId))
  if (!meta || meta.projectId !== projectId) throw new Error('chat not found in project')
  return meta
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
  return withProjectWriteLock(projectId, async () => {
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
  })
}

/** 更新对话 meta 的可变字段（contextRange / lockedRange / injectionOverrides）*/
export async function updateChatMeta(
  chatId: string,
  patch: Partial<Pick<ChatMeta, 'contextRange' | 'lockedRange' | 'injectionOverrides' | 'summaryLearning'>>
): Promise<ChatMeta> {
  const chat = await getChatMeta(chatId)
  return withProjectWriteLock(chat.projectId, () => mutateChatMeta(chatId, (current) => {
    if (current.system === FEATURE_GUIDE_PROJECT_KIND) {
      throw new Error('Built-in feature guide chat cannot be modified')
    }
    if (current.status !== 'normal') throw new Error('chat is not active')
    return { ...current, ...patch, updatedAt: nowIso() }
  }))
}

export async function getChat(chatId: string): Promise<{ chat: ChatMeta; messages: ChatMessage[] }> {
  const chat = await getChatMeta(chatId)
  const messages = await readJsonl<ChatMessage>(chatJsonlPath(chat.projectId, chatId))
  return { chat, messages }
}

export async function getChatForSummary(projectId: string, chatId: string): Promise<{ chat: ChatMeta; messages: ChatMessage[] }> {
  await assertSummaryEntityActive(projectId, 'chat', chatId)
  const chat = await getChatMetaInProject(projectId, chatId)
  const messages = await readJsonl<ChatMessage>(chatJsonlPath(projectId, chatId))
  return { chat, messages }
}

export async function renameChat(chatId: string, title: string): Promise<ChatMeta> {
  const chat = await getChatMeta(chatId)
  return withProjectWriteLock(chat.projectId, () => mutateChatMeta(chatId, async (current) => {
    await assertProjectContentMutable(current.projectId)
    if (current.status !== 'normal') throw new Error('chat is not active')
    return { ...current, title, updatedAt: nowIso() }
  }))
}

/** 更新上下文对话的上下文范围（PRD 6.4 / 6.6）*/
export async function updateChatContext(
  chatId: string,
  contextRange: import('@shared/types').ContextRange
): Promise<ChatMeta> {
  const chat = await getChatMeta(chatId)
  return withProjectWriteLock(chat.projectId, () => mutateChatMeta(chatId, (current) => {
    if (current.system === FEATURE_GUIDE_PROJECT_KIND) {
      throw new Error('Built-in feature guide chat cannot be modified')
    }
    if (current.status !== 'normal') throw new Error('chat is not active')
    return { ...current, contextRange, updatedAt: nowIso() }
  }))
}

async function mutateChatContent<T>(chatId: string, operation: () => Promise<T>): Promise<T> {
  return enqueueSerialized(`chat-content:${chatId}`, operation)
}

export async function appendMessage(chatId: string, message: ChatMessage): Promise<void> {
  const chat = await getChatMeta(chatId)
  await withProjectWriteLock(chat.projectId, () => mutateChatContent(chatId, async () => {
    const current = await getChatMeta(chatId)
    if (current.system !== FEATURE_GUIDE_PROJECT_KIND) await assertProjectContentMutable(current.projectId)
    if (current.status !== 'normal') throw new Error('chat is not active')
    const persistedMessage = current.system === FEATURE_GUIDE_PROJECT_KIND && message.attachments?.length
      ? { ...message, attachments: [] }
      : message
    await appendJsonl(chatJsonlPath(current.projectId, chatId), persistedMessage)
    await mutateChatMeta(chatId, (latest) => ({ ...latest, updatedAt: nowIso() }))
  }))
}

/** Replace the latest assistant answer and return its persisted ID. */
export async function replaceLastAssistantMessage(
  chatId: string,
  content: string,
  reasoning: string | undefined,
  memory: ChatMessage['memory']
): Promise<string | null> {
  const chat = await getChatMeta(chatId)
  return withProjectWriteLock(chat.projectId, () => mutateChatContent(chatId, async () => {
    const { chat: currentChat, messages } = await getChat(chatId)
    if (currentChat.system !== FEATURE_GUIDE_PROJECT_KIND) await assertProjectContentMutable(currentChat.projectId)
    if (currentChat.status !== 'normal') throw new Error('chat is not active')
    let messageId: string | null = null
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        messages[i] = { ...messages[i], content, regenerated: true, reasoning, memory }
        messageId = messages[i].id
        break
      }
    }
    await atomicWrite(chatJsonlPath(currentChat.projectId, chatId), messages.map((m) => JSON.stringify(m)).join('\n') + (messages.length ? '\n' : ''))
    await mutateChatMeta(chatId, (latest) => ({ ...latest, updatedAt: nowIso() }))
    return messageId
  }))
}

/** 用户归档对话（PRD 4.2.1）*/
export async function deleteChat(chatId: string): Promise<void> {
  const chat = await getChatMeta(chatId)
  if (chat.system === FEATURE_GUIDE_PROJECT_KIND) throw new Error('Built-in feature guide chat cannot be deleted individually')
  await withProjectWriteLock(chat.projectId, () => mutateChatMeta(chatId, async (current) => {
    await assertProjectContentMutable(current.projectId)
    return { ...current, status: 'user_archived', updatedAt: nowIso() }
  }))
}

export async function restoreChat(chatId: string): Promise<ChatMeta> {
  const current = await getChatMeta(chatId)
  if (current.system === FEATURE_GUIDE_PROJECT_KIND) throw new Error('Built-in feature guide chat cannot be restored individually')
  return withProjectWriteLock(current.projectId, () => mutateChatMeta(chatId, async (chat) => {
    await assertProjectContentMutable(chat.projectId)
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
  }))
}

export async function purgeChat(chatId: string): Promise<void> {
  const chat = await getChatMeta(chatId)
  if (chat.system === FEATURE_GUIDE_PROJECT_KIND) throw new Error('Built-in feature guide chat cannot be deleted individually')
  await withProjectLifecycle(chat.projectId, async () => {
    const current = await getChatMetaInProject(chat.projectId, chatId)
    if (current.system === FEATURE_GUIDE_PROJECT_KIND) throw new Error('Built-in feature guide chat cannot be deleted individually')
    const stage = join(projectDir(chat.projectId), `${entityPurgeStagePrefix('chat', chatId)}${newId()}`)
    const sources = [...new Set(await chatArtifactPaths(chat.projectId, chatId))]
    const planned = sources.map((source) => ({ source, target: stageTarget(stage, source, chat.projectId) }))
    await runStagedPurge(chat.projectId, stage, planned, async () => undefined)
  })
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
  return withProjectWriteLock(projectId, async () => {
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


async function uploadResourceBytesUnlocked(
  projectId: string,
  name: string,
  data: Uint8Array,
  encodingHint?: string
): Promise<ResourceMeta> {
  await assertProjectContentMutable(projectId)
  const converted = await convertResourceInput(name, data, encodingHint)
  return createResourceFiles(projectId, name, data, converted)
}

export async function uploadResourceBytes(
  projectId: string,
  name: string,
  data: Uint8Array,
  encodingHint?: string
): Promise<ResourceMeta> {
  return withProjectWriteLock(projectId, () => uploadResourceBytesUnlocked(projectId, name, data, encodingHint))
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
  return withProjectWriteLock(projectId, () => mutateResource(projectId, resourceId, async () => {
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
  }))
}

export async function replaceResourceBytes(
  projectId: string,
  resourceId: string,
  data: Uint8Array,
  encodingHint?: string,
  sourceName?: string
): Promise<ResourceMeta> {
  return withProjectWriteLock(projectId, () => mutateResource(projectId, resourceId, async () => {
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
  }))
}

export async function deleteResource(projectId: string, resourceId: string): Promise<void> {
  await withProjectLifecycle(projectId, () => mutateResource(projectId, resourceId, async () => {
    await assertProjectContentMutable(projectId)
    assertResourceMutationAllowed(resourceId)
    const current = await readJson<ResourceMeta>(resourceMetaPath(projectId, resourceId))
    if (!current || current.projectId !== projectId) throw new Error('resource not found')

    const stage = join(projectDir(projectId), `${entityPurgeStagePrefix('resource', resourceId)}${newId()}`)
    const sources = [
      resourceDir(projectId, resourceId),
      resourceSummaryPath(projectId, resourceId),
      settingDistillationCheckpointPath(projectId, resourceId),
      vectorIndexPath(projectId)
    ]
    const planned = [...new Set(sources)].map((source) => ({
      source,
      target: stageTarget(stage, source, projectId)
    }))
    await runStagedPurge(projectId, stage, planned, async () => {
      await removeVectorSourceFromIndex(
        projectId,
        resourceId,
        'res',
        stageTarget(stage, vectorIndexPath(projectId), projectId)
      )
    })
  }))
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
  return withProjectWriteLock(projectId, async () => {
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
  })
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
  return withProjectWriteLock(projectId, async () => {
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
      resource = await uploadResourceBytesUnlocked(projectId, source.name, source.data, source.encodingHint)
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
  })
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
  await assertSummaryEntityActive(projectId, 'doc', docId)
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
  await assertSummaryEntityActive(projectId, 'chat', chatId)
  await atomicWriteJson(chatSummaryPath(projectId, chatId), summary)
}

export async function readResourceSummary(projectId: string, resourceId: string): Promise<ResourceSummary | null> {
  const s = await readJson<ResourceSummary>(resourceSummaryPath(projectId, resourceId))
  if (!s || s.schemaVersion !== SUMMARY_SCHEMA_VERSION) return null
  if (!s.knowledge || !s.generation || !Array.isArray(s.chunkResults)) return null
  return s
}

export async function writeResourceSummary(projectId: string, resourceId: string, summary: ResourceSummary): Promise<void> {
  await assertSummaryEntityActive(projectId, 'resource', resourceId)
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
  await assertSummaryEntityActive(projectId, 'resource', resourceId)
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
  await assertSummaryProjectActive(projectId)
  await atomicWriteJson(rollupsPath(projectId), { rollups })
}

export async function readVectorIndex(projectId: string): Promise<VectorIndex | null> {
  return readJson<VectorIndex>(vectorIndexPath(projectId))
}

export async function writeVectorIndex(projectId: string, index: VectorIndex): Promise<void> {
  await assertSummaryProjectActive(projectId)
  for (const source of index.sources ?? []) {
    await assertSummaryEntityActive(projectId, source.kind === 'doc' ? 'doc' : 'resource', source.id)
  }
  await atomicWriteJson(vectorIndexPath(projectId), index)
}

// ---------------------------------------------------------------------------
// 工作区快照
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
