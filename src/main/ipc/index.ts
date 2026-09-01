import { dialog, ipcMain, clipboard } from 'electron'
import { EVENTS, IPC, type IpcApi } from '@shared/ipc'
import type { RecoveryState } from '@shared/types'
import {
  hasWorkspace,
  loadConfig,
  setConfig
} from '../services/config.service'
import {
  appendMessage,
  attachResourceSnapshot,
  buildSnapshot,
  createChat,
  createDoc,
  createProject,
  deleteChat,
  deleteDoc,
  deleteProject,
  deleteResource,
  ensureWorkspace,
  findDocMeta,
  getChat,
  importExternalFile,
  importExternalResource,
  listResources,
  purgeChat,
  purgeDoc,
  purgeProject,
  readChatSummary,
  readDoc,
  readDocSummary,
  readResource,
  readResourceSummary,
  replaceResourceBytes,
  renameChat,
  renameDoc,
  renameProject,
  setProjectSummaryAutoMaintenance,
  restoreChat,
  restoreDoc,
  restoreProject,
  saveDoc,
  saveResourceText,
  updateChatContext,
  updateChatMeta,
  uploadResourceBytes
} from '../services/file.service'
import { hasApiKey, setApiKey } from '../services/crypto.service'
import { cancelStream, generateChatTitle, listModels, streamChat, testConnection } from '../services/api.service'
import {
  getDefaultActiveKeys,
  getDocRollup,
  listDocRollups,
  listProjectSummaries,
  scanConsistency,
  searchProjectSummaries,
  undistillResource
} from '../services/summary.service'
import {
  distillResourceInWorker,
  generateDocRollupsInWorker,
  queueChatSummaryInWorker,
  regenerateChatSummaryInWorker,
  regenerateDocRollupInWorker,
  regenerateDocSummaryInWorker,
  retryPendingSummariesInWorker
} from '../services/summary-job-manager'
import { getSnapshot } from '../services/usage.service'
import { buildVectorIndex, getVectorIndexStatus, rebuildVectorSource, searchVectorIndex, queueVectorSourceRemoval, queueVectorSourceSync } from '../services/vector.service'
import { commitAllProjects, commitProject, gitLog, rollback } from '../services/git.service'
import { ensureGit } from '../install/git-installer'
import { exportDoc, exportProject } from '../services/export.service'
import { clearRecovery, readRecovery, updateRecovery } from '../services/recovery.service'
import { migrateWorkspace } from '../services/migration.service'
import { logError } from '../services/log.service'
import { applyProjectDocSummaryMaintenance, cancelDocSummaryMaintenance, cancelProjectDocSummaryMaintenance, initializeDocSummaryMaintenance, scheduleDocSummaryMaintenance } from '../services/doc-summary-maintenance.service'
import { broadcast, getMainWindow } from '../window'

type Handler<K extends keyof IpcApi> = (req: IpcApi[K]['req']) => Promise<IpcApi[K]['res']> | IpcApi[K]['res']

function handle<K extends keyof IpcApi>(channel: K, fn: Handler<K>): void {
  ipcMain.handle(channel, async (_event, req) => {
    try {
      return await fn(req)
    } catch (err) {
      logError(`ipc:${String(channel)}`, (err as Error).message, (err as Error).stack)
      throw err
    }
  })
}

export function registerIpcHandlers(): void {
  // 配置
  handle(IPC.configGet, () => loadConfig())
  handle(IPC.configSet, async (patch) => {
    const next = await setConfig(patch)
    if (patch.workspaceDir !== undefined || patch.summaryEnabled !== undefined) {
      await initializeDocSummaryMaintenance()
    }
    broadcast(EVENTS.configChanged, next)
    return next
  })
  handle(IPC.configChooseWorkspace, async () => {
    const win = getMainWindow()
    const res = await dialog.showOpenDialog(win!, {
      title: '选择工作目录',
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  // 工作区
  handle(IPC.workspaceGet, async () => {
    if (!(await hasWorkspace())) {
      return { workspaceDir: '', projects: [], trashedProjects: [] }
    }
    await ensureWorkspace()
    return buildSnapshot()
  })
  handle(IPC.workspaceMigrate, async (target) => {
    const res = await migrateWorkspace(target)
    if (res.ok) {
      await initializeDocSummaryMaintenance()
      broadcast(EVENTS.configChanged, await loadConfig())
    }
    return res
  })

  // 项目
  handle(IPC.projectCreate, (req) => createProject(req.name))
  handle(IPC.projectRename, (req) => renameProject(req.projectId, req.name))
  handle(IPC.projectSetSummaryAutoMaintenance, async (req) => {
    const project = await setProjectSummaryAutoMaintenance(req.projectId, req.enabled)
    await applyProjectDocSummaryMaintenance(req.projectId, req.enabled)
    return project
  })
  handle(IPC.projectDelete, async (id) => {
    cancelProjectDocSummaryMaintenance(id)
    return deleteProject(id)
  })
  handle(IPC.projectRestore, async (id) => {
    const project = await restoreProject(id)
    await applyProjectDocSummaryMaintenance(project.id, project.summaryAutoMaintenance === true)
    return project
  })
  handle(IPC.projectPurge, async (id) => {
    cancelProjectDocSummaryMaintenance(id)
    return purgeProject(id)
  })

  // 文档
  handle(IPC.docCreate, (req) => createDoc(req.projectId, req.title))
  handle(IPC.docRead, (id) => readDoc(id))
  handle(IPC.docSave, async (req) => {
    const doc = await findDocMeta(req.docId)
    const result = await saveDoc(req.docId, req.content, req.editorFormat)
    if (doc) {
      queueVectorSourceSync(doc.projectId, doc.id, 'doc')
      await scheduleDocSummaryMaintenance(doc.projectId, doc.id)
    }
    return result
  })
  handle(IPC.docRename, async (req) => {
    const doc = await findDocMeta(req.docId)
    const result = await renameDoc(req.docId, req.title)
    if (doc) queueVectorSourceSync(doc.projectId, doc.id, 'doc')
    return result
  })
  handle(IPC.docDelete, async (id) => {
    const doc = await findDocMeta(id)
    const result = await deleteDoc(id)
    if (doc) {
      cancelDocSummaryMaintenance(doc.projectId, doc.id)
      queueVectorSourceRemoval(doc.projectId, doc.id, 'doc')
    }
    return result
  })
  handle(IPC.docRestore, async (id) => {
    const doc = await findDocMeta(id)
    const result = await restoreDoc(id)
    if (doc) {
      queueVectorSourceSync(doc.projectId, doc.id, 'doc')
      await scheduleDocSummaryMaintenance(doc.projectId, doc.id)
    }
    return result
  })
  handle(IPC.docPurge, async (id) => {
    const doc = await findDocMeta(id)
    const result = await purgeDoc(id)
    if (doc) {
      cancelDocSummaryMaintenance(doc.projectId, doc.id)
      queueVectorSourceRemoval(doc.projectId, doc.id, 'doc')
    }
    return result
  })

  // 对话
  handle(IPC.chatCreate, (req) => createChat(req.projectId, req.kind, req.title, req.docId, req.contextRange, req.action))
  handle(IPC.chatGet, (id) => getChat(id))
  handle(IPC.chatRename, (req) => renameChat(req.chatId, req.title))
  handle(IPC.chatAppend, (req) => appendMessage(req.chatId, req.message))
  handle(IPC.chatAttachResource, async (req) => {
    const result = await attachResourceSnapshot(req.chatId, req.projectId, req.source)
    if (req.source.mode === 'local' && result.resource?.id) {
      queueVectorSourceSync(req.projectId, result.resource.id, 'res')
    }
    return result
  })
  handle(IPC.chatDelete, (id) => deleteChat(id))
  handle(IPC.chatRestore, (id) => restoreChat(id))
  handle(IPC.chatPurge, (id) => purgeChat(id))
  handle(IPC.chatSetContext, (req) => updateChatContext(req.chatId, req.contextRange))
  handle(IPC.chatPatch, (req) => updateChatMeta(req.chatId, req.patch))
  handle(IPC.chatGenerateTitle, (chatId) => generateChatTitle(chatId))

  // 资源
  handle(IPC.resourceList, (projectId) => listResources(projectId))
  handle(IPC.resourceUpload, async (req) => {
    const result = await uploadResourceBytes(req.projectId, req.name, req.data, req.encodingHint)
    queueVectorSourceSync(req.projectId, result.id, 'res')
    return result
  })
  handle(IPC.resourceRead, (req) => readResource(req.projectId, req.resourceId))
  handle(IPC.resourceSaveText, async (req) => {
    const result = await saveResourceText(req.projectId, req.resourceId, req.content)
    queueVectorSourceSync(req.projectId, req.resourceId, 'res')
    return result
  })
  handle(IPC.resourceReplace, async (req) => {
    const result = await replaceResourceBytes(req.projectId, req.resourceId, req.data, req.encodingHint, req.sourceName)
    queueVectorSourceSync(req.projectId, req.resourceId, 'res')
    return result
  })
  handle(IPC.resourceImportExternal, async (req) => {
    const result = await importExternalResource(req.projectId, req.name, req.data, req.content, req.conflict)
    queueVectorSourceSync(req.projectId, result.id, 'res')
    return result
  })
  handle(IPC.resourceDelete, async (req) => {
    const result = await deleteResource(req.projectId, req.resourceId)
    queueVectorSourceRemoval(req.projectId, req.resourceId, 'res')
    return result
  })
  handle(IPC.resourceDistill, (req) => distillResourceInWorker(req.projectId, req.resourceId, req.type, req.force))
  handle(IPC.resourceUndistill, (req) => undistillResource(req.projectId, req.resourceId))
  handle(IPC.fileOpenExternal, (path) => importExternalFile(path))

  // AI
  handle(IPC.apiStreamChat, (req) => {
    void streamChat(req)
  })
  handle(IPC.apiCancelStream, (requestId) => {
    cancelStream(requestId)
  })
  handle(IPC.apiListModels, (req) => listModels(req))

  // 剪贴板
  handle(IPC.clipboardRead, () => clipboard.readText())
  handle(IPC.clipboardWrite, (text) => {
    clipboard.writeText(text)
  })

  // 错误日志（渲染层上报）
  handle(IPC.logError, (req) => {
    logError(req.source, req.message, req.stack)
  })

  // 加密 / 联通测试
  handle(IPC.cryptoSetApiKey, (key) => setApiKey(key))
  handle(IPC.cryptoHasApiKey, () => hasApiKey())
  handle(IPC.cryptoTestConnection, () => testConnection())

  // 摘要
  handle(IPC.summaryGetDoc, async (docId) => {
    const doc = await findDocMeta(docId)
    return readDocSummary(doc.projectId, docId)
  })
  handle(IPC.summaryGetChat, async (chatId) => {
    const { chat } = await getChat(chatId)
    return readChatSummary(chat.projectId, chatId)
  })
  handle(IPC.summaryGetResource, (req) => readResourceSummary(req.projectId, req.resourceId))
  handle(IPC.summaryListProject, (projectId) => listProjectSummaries(projectId))
  handle(IPC.summaryRegenerateDoc, (req) => regenerateDocSummaryInWorker(req.docId, req.forceFull ?? false))
  handle(IPC.summaryRegenerateChat, (chatId) => regenerateChatSummaryInWorker(chatId))
  handle(IPC.summaryQueueChat, (chatId) => {
    void queueChatSummaryInWorker(chatId)
  })
  handle(IPC.summaryDefaultActive, (chatId) => getDefaultActiveKeys(chatId))
  handle(IPC.summarySearch, (req) => searchProjectSummaries(req.projectId, req.query))
  handle(IPC.summaryListRollups, (projectId) => listDocRollups(projectId))
  handle(IPC.summaryGenerateRollups, (projectId) => generateDocRollupsInWorker(projectId))
  handle(IPC.summaryRegenerateRollup, (req) => regenerateDocRollupInWorker(req.projectId, req.rollupId))
  handle(IPC.summaryGetRollup, (req) => getDocRollup(req.projectId, req.rollupId))
  handle(IPC.summaryScanConsistency, (projectId) => scanConsistency(projectId))
  handle(IPC.vectorBuild, (projectId) => buildVectorIndex(projectId))
  handle(IPC.vectorRebuildSource, (req) => rebuildVectorSource(req.projectId, req.id, req.kind))
  handle(IPC.vectorStatus, (projectId) => getVectorIndexStatus(projectId))
  handle(IPC.vectorSearch, (req) => searchVectorIndex(req.projectId, req.query))

  // 用量
  handle(IPC.usageGet, () => getSnapshot())

  // 版本管理
  handle(IPC.gitEnsure, (req) => ensureGit(req.consent))
  handle(IPC.gitCommit, (projectId) => commitProject(projectId))
  handle(IPC.gitCommitAll, () => commitAllProjects())
  handle(IPC.gitLog, (projectId) => gitLog(projectId))
  handle(IPC.gitRollback, (req) => rollback(req.projectId, req.hash))

  // 导出
  handle(IPC.exportDoc, (req) => exportDoc(req.docId, req.format))
  handle(IPC.exportProject, (req) => exportProject(req.projectId, req.options))

  // 恢复
  handle(IPC.recoveryCheck, () => readRecovery())
  handle(IPC.recoveryClear, () => clearRecovery())
  handle(IPC.recoveryUpdate, (state: RecoveryState) => updateRecovery(state))
}

/** 供主进程退出前调用：重试遗留摘要任务 */
export async function onBeforeQuitTasks(): Promise<void> {
  await retryPendingSummariesInWorker()
}
