// IPC 濂戠害锛歝hannel 鍚嶇О涓?request/response 绫诲瀷銆?
// main 杩涚▼閫氳繃 ipcMain.handle 娉ㄥ唽锛宺enderer 閫氳繃 preload 鏆撮湶鐨勭被鍨嬪寲 API 璋冪敤銆?

import type { SummaryProgress } from './summary-job-protocol'

import type {
  AppConfig,
  ChatAction,
  ChatMessage,
  ChatMeta,
  ChatSummary,
  ConnectionTestResult,
  ConsistencyIssue,
  ContextRange,
  DistillResult,
  DocEditorFormat,
  DocMeta,
  DocRollup,
  DocRollupOverview,
  DocSummary,
  ExportProjectOptions,
  ExternalFileResult,
  GitCommitInfo,
  ProjectMeta,
  ProjectSummariesOverview,
  RecoveryState,
  ResourceMeta,
  ResourceDistillType,
  ResourceSummary,
  TextEncodingInfo,
  StreamDonePayload,
  StreamRequest,
  SummarySearchResult,
  UploadResult,
  UsageSnapshot,
  VectorIndexStatus,
  VectorSearchHit,
  WorkspaceSnapshot
} from './types'

export interface ProjectCreateInput {
  name: string
}

export interface DocCreateInput {
  projectId: string
  title: string
}

export interface ChatCreateInput {
  projectId: string
  kind: 'project' | 'doc' | 'context'
  title: string
  docId?: string
  contextRange?: ContextRange
  /** 鍙抽敭鍒涘缓涓婁笅鏂囧璇濈殑鍔ㄤ綔锛堣瘖鏂?璧板悜/浼樺寲锛?*/
  action?: ChatAction
}

export interface ChatGetResult {
  chat: ChatMeta
  messages: ChatMessage[]
}

export interface BinaryTextFileInput {
  name: string
  data: Uint8Array
  encodingHint?: string
}

export interface ResourceUploadInput extends BinaryTextFileInput {
  projectId: string
}

export interface StreamChatInput extends StreamRequest {}

export interface UsageResult {
  snapshot: UsageSnapshot
}

/** 涓昏繘绋?鈫?娓叉煋杩涚▼鐨勪簨浠堕€氶亾 */
export const EVENTS = {
  openExternalFile: 'open-external-file',
  streamChunk: 'stream:chunk',
  streamDone: 'stream:done',
  migrateProgress: 'migrate:progress',
  gitInstallProgress: 'git:install-progress',
  configChanged: 'config:changed',
  appFlush: 'app:flush',
  summaryStatus: 'summary:status',
  summaryProgress: 'summary:progress'
} as const

/** 娓叉煋杩涚▼ 鈫?涓昏繘绋嬬殑 invoke 閫氶亾 */
export const IPC = {
  configGet: 'config:get',
  configSet: 'config:set',
  configChooseWorkspace: 'config:choose-workspace',
  workspaceGet: 'workspace:get',
  workspaceMigrate: 'workspace:migrate',
  projectCreate: 'project:create',
  projectRename: 'project:rename',
  projectDelete: 'project:delete',
  projectRestore: 'project:restore',
  projectPurge: 'project:purge',
  docCreate: 'doc:create',
  docRead: 'doc:read',
  docSave: 'doc:save',
  docRename: 'doc:rename',
  docDelete: 'doc:delete',
  docRestore: 'doc:restore',
  docPurge: 'doc:purge',
  chatCreate: 'chat:create',
  chatGet: 'chat:get',
  chatRename: 'chat:rename',
  chatAppend: 'chat:append',
  chatAttachResource: 'chat:attachResource',
  chatDelete: 'chat:delete',
  chatRestore: 'chat:restore',
  chatPurge: 'chat:purge',
  chatSetContext: 'chat:setContext',
  chatPatch: 'chat:patch',
  chatGenerateTitle: 'chat:generateTitle',
  resourceList: 'resource:list',
  resourceUpload: 'resource:upload',
  resourceRead: 'resource:read',
  resourceReplace: 'resource:replace',
  resourceDelete: 'resource:delete',
  resourceDistill: 'resource:distill',
  resourceUndistill: 'resource:undistill',
  fileOpenExternal: 'file:openExternal',
  apiStreamChat: 'api:streamChat',
  apiCancelStream: 'api:cancelStream',
  apiListModels: 'api:listModels',
  cryptoSetApiKey: 'crypto:setApiKey',
  cryptoHasApiKey: 'crypto:hasApiKey',
  cryptoTestConnection: 'crypto:testConnection',
  clipboardRead: 'clipboard:read',
  clipboardWrite: 'clipboard:write',
  logError: 'log:error',
  summaryGetDoc: 'summary:getDoc',
  summaryGetChat: 'summary:getChat',
  summaryGetResource: 'summary:getResource',
  summaryListProject: 'summary:listProject',
  summaryRegenerateDoc: 'summary:regenerateDoc',
  summaryRegenerateChat: 'summary:regenerateChat',
  summaryQueueChat: 'summary:queueChat',
  summaryDefaultActive: 'summary:defaultActive',
  summarySearch: 'summary:search',
  summaryListRollups: 'summary:listRollups',
  summaryGenerateRollups: 'summary:generateRollups',
  summaryRegenerateRollup: 'summary:regenerateRollup',
  summaryGetRollup: 'summary:getRollup',
  summaryScanConsistency: 'summary:scanConsistency',
  vectorBuild: 'vector:build',
  vectorRebuildSource: 'vector:rebuildSource',
  vectorStatus: 'vector:status',
  vectorSearch: 'vector:search',
  usageGet: 'usage:get',
  gitEnsure: 'git:ensure',
  gitCommit: 'git:commit',
  gitCommitAll: 'git:commitAll',
  gitLog: 'git:log',
  gitRollback: 'git:rollback',
  exportDoc: 'export:doc',
  exportProject: 'export:project',
  recoveryCheck: 'recovery:check',
  recoveryClear: 'recovery:clear',
  recoveryUpdate: 'recovery:update'
} as const

/** 鎵€鏈?invoke 閫氶亾瀵瑰簲鐨勮姹?鍝嶅簲绫诲瀷鏄犲皠 */
export interface IpcApi {
  [IPC.configGet]: { req: void; res: AppConfig }
  [IPC.configSet]: { req: Partial<AppConfig>; res: AppConfig }
  [IPC.configChooseWorkspace]: { req: void; res: string | null }
  [IPC.workspaceGet]: { req: void; res: WorkspaceSnapshot }
  [IPC.workspaceMigrate]: { req: string; res: { ok: boolean; error?: string } }
  [IPC.projectCreate]: { req: ProjectCreateInput; res: ProjectMeta }
  [IPC.projectRename]: { req: { projectId: string; name: string }; res: ProjectMeta }
  [IPC.projectDelete]: { req: string; res: void }
  [IPC.projectRestore]: { req: string; res: ProjectMeta }
  [IPC.projectPurge]: { req: string; res: void }
  [IPC.docCreate]: { req: DocCreateInput; res: DocMeta }
  [IPC.docRead]: { req: string; res: { doc: DocMeta; content: string } }
  [IPC.docSave]: { req: { docId: string; content: string; editorFormat?: DocEditorFormat }; res: void }
  [IPC.docRename]: { req: { docId: string; title: string }; res: DocMeta }
  [IPC.docDelete]: { req: string; res: void }
  [IPC.docRestore]: { req: string; res: DocMeta }
  [IPC.docPurge]: { req: string; res: void }
  [IPC.chatCreate]: { req: ChatCreateInput; res: ChatMeta }
  [IPC.chatGet]: { req: string; res: ChatGetResult }
  [IPC.chatRename]: { req: { chatId: string; title: string }; res: ChatMeta }
  [IPC.chatAppend]: { req: { chatId: string; message: ChatMessage }; res: void }
  [IPC.chatAttachResource]: {
    req: {
      chatId: string
      projectId: string
      source: { mode: 'resource'; resourceId: string } | ({ mode: 'local' } & BinaryTextFileInput)
    }
    res: UploadResult
  }
  [IPC.chatDelete]: { req: string; res: void }
  [IPC.chatRestore]: { req: string; res: ChatMeta }
  [IPC.chatPurge]: { req: string; res: void }
  [IPC.chatSetContext]: { req: { chatId: string; contextRange: ContextRange }; res: ChatMeta }
  [IPC.chatPatch]: {
    req: {
      chatId: string
      patch: Partial<Pick<ChatMeta, 'contextRange' | 'lockedRange' | 'injectionOverrides'>>
    }
    res: ChatMeta
  }
  [IPC.chatGenerateTitle]: { req: string; res: { ok: boolean; title?: string; error?: string } }
  [IPC.resourceList]: { req: string; res: ResourceMeta[] }
  [IPC.resourceUpload]: { req: ResourceUploadInput; res: ResourceMeta }
  [IPC.resourceRead]: {
    req: { resourceId: string; projectId: string }
    res: { content: string; name: string; encoding: TextEncodingInfo }
  }
  [IPC.resourceReplace]: {
    req: { resourceId: string; projectId: string; data: Uint8Array; encodingHint?: string }
    res: ResourceMeta
  }
  [IPC.resourceDelete]: { req: { resourceId: string; projectId: string }; res: void }
  [IPC.resourceDistill]: {
    req: { projectId: string; resourceId: string; type: ResourceDistillType; force?: boolean }
    res: DistillResult
  }
  [IPC.resourceUndistill]: { req: { projectId: string; resourceId: string }; res: void }
  [IPC.fileOpenExternal]: { req: string; res: ExternalFileResult }
  [IPC.apiStreamChat]: { req: StreamChatInput; res: void }
  [IPC.apiCancelStream]: { req: string; res: void }
  [IPC.apiListModels]: {
    req: { baseURL?: string; apiKey?: string }
    res: { ok: boolean; models?: string[]; error?: string }
  }
  [IPC.cryptoSetApiKey]: { req: string; res: void }
  [IPC.cryptoHasApiKey]: { req: void; res: boolean }
  [IPC.cryptoTestConnection]: { req: void; res: ConnectionTestResult }
  [IPC.clipboardRead]: { req: void; res: string }
  [IPC.clipboardWrite]: { req: string; res: void }
  [IPC.logError]: { req: { source: string; message: string; stack?: string }; res: void }
  [IPC.summaryGetDoc]: { req: string; res: DocSummary | null }
  [IPC.summaryGetChat]: { req: string; res: ChatSummary | null }
  [IPC.summaryGetResource]: { req: { projectId: string; resourceId: string }; res: ResourceSummary | null }
  [IPC.summaryListProject]: { req: string; res: ProjectSummariesOverview }
  [IPC.summaryRegenerateDoc]: { req: string; res: { ok: boolean; error?: string } }
  [IPC.summaryRegenerateChat]: { req: string; res: { ok: boolean; error?: string } }
  [IPC.summaryQueueChat]: { req: string; res: void }
  [IPC.summaryDefaultActive]: { req: string; res: string[] }
  [IPC.summarySearch]: { req: { projectId: string; query: string }; res: SummarySearchResult[] }
  [IPC.summaryListRollups]: { req: string; res: DocRollupOverview }
  [IPC.summaryGenerateRollups]: { req: string; res: { ok: boolean; error?: string } }
  [IPC.summaryRegenerateRollup]: { req: { projectId: string; rollupId: string }; res: { ok: boolean; error?: string } }
  [IPC.summaryGetRollup]: { req: { projectId: string; rollupId: string }; res: DocRollup | null }
  [IPC.summaryScanConsistency]: { req: string; res: ConsistencyIssue[] }
  [IPC.vectorBuild]: {
    req: string
    res: { ok: boolean; error?: string; chunkCount?: number; embedModel?: string }
  }
  [IPC.vectorRebuildSource]: { req: { projectId: string; id: string; kind: 'doc' | 'res' }; res: { ok: boolean; error?: string; chunkCount?: number; embedModel?: string } }
  [IPC.vectorStatus]: { req: string; res: VectorIndexStatus }
  [IPC.vectorSearch]: { req: { projectId: string; query: string }; res: VectorSearchHit[] }
  [IPC.usageGet]: { req: void; res: UsageSnapshot }
  [IPC.gitEnsure]: { req: { consent: boolean }; res: { ok: boolean; reason?: string; path?: string } }
  [IPC.gitCommit]: { req: string; res: { ok: boolean; committed?: boolean; error?: string } }
  [IPC.gitCommitAll]: { req: void; res: { committed: string[]; errors: string[] } }
  [IPC.gitLog]: { req: string; res: GitCommitInfo[] }
  [IPC.gitRollback]: { req: { projectId: string; hash: string }; res: { ok: boolean; error?: string } }
  [IPC.exportDoc]: { req: { docId: string; format: 'md' | 'txt' }; res: { ok: boolean; path?: string; error?: string } }
  [IPC.exportProject]: { req: { projectId: string; options: ExportProjectOptions }; res: { ok: boolean; path?: string; error?: string } }
  [IPC.recoveryCheck]: { req: void; res: RecoveryState | null }
  [IPC.recoveryClear]: { req: void; res: void }
  [IPC.recoveryUpdate]: { req: RecoveryState; res: void }
}

export type IpcChannel = keyof IpcApi

/** 浜嬩欢杞借嵎绫诲瀷 */
export interface EventPayloads {
  [EVENTS.openExternalFile]: string
  [EVENTS.streamChunk]: { chatId: string; requestId: string; delta: string; reasoningDelta?: string }
  [EVENTS.streamDone]: StreamDonePayload
  [EVENTS.migrateProgress]: { phase: string; message: string; percent: number }
  [EVENTS.gitInstallProgress]: { level: number; message: string }
  [EVENTS.configChanged]: AppConfig
  [EVENTS.appFlush]: void
  [EVENTS.summaryStatus]: { key: string; generating: boolean }
  [EVENTS.summaryProgress]: SummaryProgress
}

export type EventChannel = keyof EventPayloads

/** preload 鏆撮湶缁?renderer 鐨勭被鍨嬪寲 API */
export interface RendererApi {
  invoke<K extends IpcChannel>(channel: K, req: IpcApi[K]['req']): Promise<IpcApi[K]['res']>
  on<E extends EventChannel>(channel: E, listener: (payload: EventPayloads[E]) => void): () => void
}
