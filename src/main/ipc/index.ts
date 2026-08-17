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
  restoreChat,
  restoreDoc,
  restoreProject,
  saveDoc,
  updateChatContext,
  updateChatMeta,
  uploadResourceBytes
} from '../services/file.service'
import { hasApiKey, setApiKey } from '../services/crypto.service'
import { cancelStream, generateChatTitle, listModels, streamChat, testConnection } from '../services/api.service'
import {
  distillResource,
  generateDocRollups,
  getDefaultActiveKeys,
  getDocRollup,
  listDocRollups,
  listProjectSummaries,
  queueChatSummary,
  regenerateChatSummary,
  regenerateDocRollup,
  regenerateDocSummary,
  retryPendingSummaries,
  scanConsistency,
  searchProjectSummaries,
  undistillResource
} from '../services/summary.service'
import { getSnapshot } from '../services/usage.service'
import { buildVectorIndex, getVectorIndexStatus, searchVectorIndex } from '../services/vector.service'
import { commitAllProjects, commitProject, gitLog, rollback } from '../services/git.service'
import { ensureGit } from '../install/git-installer'
import { exportDoc, exportProject } from '../services/export.service'
import { clearRecovery, readRecovery, updateRecovery } from '../services/recovery.service'
import { migrateWorkspace } from '../services/migration.service'
import { logError } from '../services/log.service'
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
      // 工作目录已变更：广播新配置，让渲染层同步显示
      broadcast(EVENTS.configChanged, await loadConfig())
    }
    return res
  })

  // 项目
  handle(IPC.projectCreate, (req) => createProject(req.name))
  handle(IPC.projectRename, (req) => renameProject(req.projectId, req.name))
  handle(IPC.projectDelete, (id) => deleteProject(id))
  handle(IPC.projectRestore, (id) => restoreProject(id))
  handle(IPC.projectPurge, (id) => purgeProject(id))

  // 文档
  handle(IPC.docCreate, (req) => createDoc(req.projectId, req.title))
  handle(IPC.docRead, (id) => readDoc(id))
  handle(IPC.docSave, (req) => saveDoc(req.docId, req.content))
  handle(IPC.docRename, (req) => renameDoc(req.docId, req.title))
  handle(IPC.docDelete, (id) => deleteDoc(id))
  handle(IPC.docRestore, (id) => restoreDoc(id))
  handle(IPC.docPurge, (id) => purgeDoc(id))

  // 对话
  handle(IPC.chatCreate, (req) => createChat(req.projectId, req.kind, req.title, req.docId, req.contextRange, req.action))
  handle(IPC.chatGet, (id) => getChat(id))
  handle(IPC.chatRename, (req) => renameChat(req.chatId, req.title))
  handle(IPC.chatAppend, (req) => appendMessage(req.chatId, req.message))
  handle(IPC.chatAttachResource, (req) => attachResourceSnapshot(req.chatId, req.projectId, req.source))
  handle(IPC.chatDelete, (id) => deleteChat(id))
  handle(IPC.chatRestore, (id) => restoreChat(id))
  handle(IPC.chatPurge, (id) => purgeChat(id))
  handle(IPC.chatSetContext, (req) => updateChatContext(req.chatId, req.contextRange))
  handle(IPC.chatPatch, (req) => updateChatMeta(req.chatId, req.patch))
  handle(IPC.chatGenerateTitle, (chatId) => generateChatTitle(chatId))

  // 资源
  handle(IPC.resourceList, (projectId) => listResources(projectId))
  handle(IPC.resourceUpload, (req) => uploadResourceBytes(req.projectId, req.name, req.data, req.encodingHint))
  handle(IPC.resourceRead, (req) => readResource(req.projectId, req.resourceId))
  handle(IPC.resourceReplace, (req) => replaceResourceBytes(req.projectId, req.resourceId, req.data, req.encodingHint))
  handle(IPC.resourceDelete, (req) => deleteResource(req.projectId, req.resourceId))
  handle(IPC.resourceDistill, (req) => distillResource(req.projectId, req.resourceId, req.type, req.force))
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
  handle(IPC.summaryRegenerateDoc, (docId) => regenerateDocSummary(docId))
  handle(IPC.summaryRegenerateChat, (chatId) => regenerateChatSummary(chatId))
  handle(IPC.summaryQueueChat, (chatId) => {
    void queueChatSummary(chatId)
  })
  handle(IPC.summaryDefaultActive, (chatId) => getDefaultActiveKeys(chatId))
  handle(IPC.summarySearch, (req) => searchProjectSummaries(req.projectId, req.query))
  handle(IPC.summaryListRollups, (projectId) => listDocRollups(projectId))
  handle(IPC.summaryGenerateRollups, (projectId) => generateDocRollups(projectId))
  handle(IPC.summaryRegenerateRollup, (req) => regenerateDocRollup(req.projectId, req.rollupId))
  handle(IPC.summaryGetRollup, (req) => getDocRollup(req.projectId, req.rollupId))
  handle(IPC.summaryScanConsistency, (projectId) => scanConsistency(projectId))
  handle(IPC.vectorBuild, (projectId) => buildVectorIndex(projectId))
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
  await retryPendingSummaries()
}
