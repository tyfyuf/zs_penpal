// 共享数据模型与类型定义（main / preload / renderer 三方共用）

export type ProjectStatus = 'normal' | 'trash'
export type DocStatus = 'normal' | 'trash'
export type ChatStatus = 'normal' | 'user_archived' | 'orphan_archived'
export type ChatKind = 'project' | 'doc' | 'context'
/** 右键创建上下文对话的动作（PRD 6.1） */
export type ChatAction = 'diagnose' | 'plot' | 'optimize'

/** 该对话的摘要注入覆盖（对当前对话窗口单独生效） */
export interface ChatInjectionOverrides {
  /** 关闭的注入键：'fulltext' | 'doc:<docId>' | 'chat:<chatId>' | 'res:<resourceId>' */
  disabled: string[]
  /** 对话开始（首条消息发出）时冻结的激活注入键；此后新加入摘要系统的摘要默认关闭 */
  active?: string[]
  /** 对话开始后用户手动开启、但尚未随新消息使用的键（此时仍可自由关闭；发送消息后并入 active） */
  pending?: string[]
}

export interface ProjectMeta {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  status: ProjectStatus
}

export interface DocMeta {
  id: string
  projectId: string
  title: string
  createdAt: string
  updatedAt: string
  status: DocStatus
}

/** 上下文范围（文档级上下文对话使用，PRD 6.4） */
export interface ContextRange {
  before: number
  after: number
  /** 文档中的锚点偏移（选区起点或光标位置） */
  anchor: number
  hasSelection: boolean
  selectionFrom?: number
  selectionTo?: number
}

export interface ChatMeta {
  id: string
  projectId: string
  kind: ChatKind
  /** 文档级 / 上下文对话关联的文档 */
  docId?: string
  title: string
  status: ChatStatus
  createdAt: string
  updatedAt: string
  /** 仅文档级上下文对话存在 */
  contextRange?: ContextRange
  /** 右键创建上下文对话的动作（诊断/走向/优化） */
  action?: ChatAction
  /** 对话开始后锁定的最小上下文范围（只能扩大，持久化，重开恢复） */
  lockedRange?: { before: number; after: number }
  /** 该对话的摘要注入覆盖（对当前对话窗口单独生效） */
  injectionOverrides?: ChatInjectionOverrides
}

export interface ResourceMeta {
  id: string
  projectId: string
  name: string
  ext: string
  size: number
  createdAt: string
}

export interface ChatAttachment {
  snapshotId: string
  name: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
  /** 该条 assistant 回答是否被重新生成替换过（PRD 6.6） */
  regenerated?: boolean
  /** 用户消息携带的资源快照附件（PRD 5.5 / 9.16） */
  attachments?: ChatAttachment[]
  /** 思维链（推理模型的 reasoning_content），仅展示用，不进入后续提示词 */
  reasoning?: string
}

// ---------------------------------------------------------------------------
// 摘要系统
// ---------------------------------------------------------------------------

export interface StoryCharacter {
  name: string
  aliases: string[]
  role: string
  goal: string
}

export interface StoryPlotPoint {
  id: string
  function: string
  summary: string
}

export interface StoryForeshadow {
  planted: string
  status: 'resolved' | 'unresolved'
}

/** 故事拆解摘要（面向故事创作者，简化的结构化故事摘要） */
export interface StorySummary {
  type: 'story'
  /** 总览 */
  overview: string
  characters: StoryCharacter[]
  /** 场景/情节链 */
  plot: StoryPlotPoint[]
  foreshadowing: StoryForeshadow[]
  keySettings: string[]
  keyQuotes: string[]
}

/** 摘要源内容指纹（三级新鲜度判定 FRESH/STALE/NEEDS_REBUILD 的信号源，替代内嵌全文快照） */
export interface SummarySourceInfo {
  schemaVersion: number
  /** 规范化（去空白/标点）后全文的 sha256 */
  sourceFingerprint: string
  /** 原始字符数 */
  sourceLength: number
  /** 规范化后字符数 */
  sourceNormalizedLength: number
}

/** 写作文档摘要 = 故事拆解 + 源指纹（不再内嵌全文快照） */
export interface DocSummary extends StorySummary, SummarySourceInfo {
  updatedAt: string
}

export interface ChatSummaryItem {
  messageId: string
  role: 'user' | 'assistant'
  summary: string
}

/** 对话摘要的压缩区间（非重叠，覆盖尾部窗口之前的旧消息） */
export interface ChatSummaryInterval {
  /** 覆盖的 turn 起始下标（0-based，含） */
  startIndex: number
  /** 覆盖的 turn 结束下标（含） */
  endIndex: number
  summary: string
  updatedAt: string
}

/** 对话摘要：尾部窗口逐条摘要 + 历史压缩区间 */
export interface ChatSummary {
  schemaVersion?: number
  /** 尾部窗口内逐条摘要（最近 N 条） */
  items: ChatSummaryItem[]
  /** 尾部窗口之前的压缩区间（非重叠，增量维护） */
  compacted: ChatSummaryInterval[]
  updatedAt: string
  /** 用于变化检测：最后一条消息 id */
  lastMessageId: string
  messageCount: number
}

/** “其他”类型资源摘要（通用文本文件拆解） */
export interface GenericResourceSummary {
  type: 'other'
  docType: string
  overview: string
  keyPoints: string[]
  keyTerms: string[]
  structure: string
}

/** 资源摘要：故事拆解 或 通用拆解 */
export type ResourceSummary = SummarySourceInfo & { updatedAt: string } & (StorySummary | GenericResourceSummary)

export interface DistillResult {
  ok: boolean
  /** 分类结果与用户所选类型不符 */
  mismatch?: boolean
  /** 分类置信度不足（<0.8），需用户确认是否仍按所选类型生成 */
  uncertain?: boolean
  detectedType?: 'story' | 'other'
  /** 判定理由（用于提示用户） */
  reasons?: string[]
  summary?: ResourceSummary
  error?: string
}

/** 摘要注入配置（按对话类型分别勾选，PRD 改进） */
export interface SummaryInjectionConfig {
  project: {
    /** 项目内所有文档摘要 */
    docSummaries: boolean
    /** 项目内所有对话摘要 */
    chatSummaries: boolean
    /** 项目内所有资源摘要 */
    resourceSummaries: boolean
  }
  doc: {
    /** 关联文档全文 */
    fullText: boolean
    /** 该文档其他对话摘要（不含当前对话） */
    docChatSummaries: boolean
    /** 项目内其他文档摘要 */
    otherDocSummaries: boolean
    /** 资源摘要 */
    resourceSummaries: boolean
  }
  context: {
    /** 项目内所有文档摘要（含该文档） */
    docSummaries: boolean
    /** 该文档其他对话摘要（不含当前对话） */
    docChatSummaries: boolean
    /** 资源摘要 */
    resourceSummaries: boolean
  }
}

/** 摘要搜索结果（注入搜索框用） */
export interface SummarySearchResult {
  key: string
  kind: 'doc' | 'chat' | 'res'
  title: string
  preview: string
  updatedAt?: string
}

/** 大摘要：每 N 个写作文档聚合的整体摘要（三级新鲜度，写作文档 > 阈值时生成） */
export interface DocRollup {
  id: string
  projectId: string
  /** 覆盖文档 id（按创建时间升序） */
  docIds: string[]
  /** 展示用范围标签，如 "1-10" */
  rangeLabel: string
  /** 跨块总体叙事 */
  overview: string
  /** 跨块状态变化（人物/世界设定），写"什么变了" */
  stateChanges: string[]
  /** 因果链 / 伏笔账本 */
  causality: string[]
  schemaVersion: number
  /** 成员文档源指纹（任一变化 → STALE） */
  sourceFingerprints: Record<string, string>
  updatedAt: string
}

/** 大摘要概览（设置页展示） */
export interface DocRollupOverview {
  rollups: {
    id: string
    rangeLabel: string
    docCount: number
    updatedAt?: string
    stale: boolean
    generating: boolean
  }[]
  totalDocs: number
  threshold: number
  batchSize: number
}

/** 摘要区（左侧栏）展示的项目摘要概览 */
export interface ProjectSummariesOverview {
  docs: { docId: string; title: string; hasSummary: boolean; updatedAt?: string; generating: boolean }[]
  chats: {
    chatId: string
    title: string
    hasSummary: boolean
    updatedAt?: string
    docId?: string
    kind?: ChatKind
    generating: boolean
  }[]
  resources: {
    resourceId: string
    name: string
    distilled: boolean
    type?: 'story' | 'other'
    updatedAt?: string
    generating: boolean
    /** 源内容已显著变化，摘要待更新（黄标） */
    stale?: boolean
  }[]
}

export interface UsageBucket {
  prompt: number
  completion: number
  total: number
  calls?: number
  /** 摘要/标题来源的 total token（图表第二折线用） */
  summary?: number
}

export interface UsageDay {
  total: UsageBucket
  hours: Record<string, UsageBucket>
  bySource: Record<string, { total: number }>
  uncounted: number
}

export interface UsageMonth {
  month: string
  days: Record<string, UsageDay>
}

export interface LifetimeUsage {
  prompt: number
  completion: number
  total: number
  uncounted: number
  /** 摘要/标题来源累计 */
  summary: number
}

export interface UsageSnapshot {
  /** 近 30 天逐日 total */
  last30Days: { date: string; total: number; prompt: number; completion: number; summary: number }[]
  /** 当日逐小时 total */
  today: { hour: string; total: number; prompt: number; completion: number; summary: number }[]
  todayTotal: number
  /** 今日摘要/标题消耗 */
  todaySummary: number
  lifetime: LifetimeUsage
  uncounted: number
}

export interface AppConfig {
  workspaceDir: string
  autosaveIntervalMs: number
  summaryEnabled: boolean
  gitEnabled: boolean
  model: string
  apiBaseUrl: string
  contextLimit: number
  gitBinaryPath?: string
  /** 摘要注入配置（按对话类型勾选） */
  summaryInjection: SummaryInjectionConfig
  /** 界面语言（暂只影响界面文案） */
  language: 'zh' | 'en'
  /** Git 提交者姓名（可选，未设置时提交时写入默认值） */
  gitAuthorName?: string
  /** Git 提交者邮箱（可选） */
  gitAuthorEmail?: string
}

export interface ProjectTree {
  project: ProjectMeta
  docs: DocMeta[]
  chats: ChatMeta[]
  resources: ResourceMeta[]
  /** 归档区中的对话 */
  archivedChats: ChatMeta[]
  /** 回收站中的文档 */
  trashedDocs: DocMeta[]
}

export interface WorkspaceSnapshot {
  workspaceDir: string
  projects: ProjectTree[]
  /** 工作目录级回收站中的项目 */
  trashedProjects: ProjectMeta[]
}

export interface GitCommitInfo {
  hash: string
  date: string
  message: string
  author: string
}

export interface UploadResult {
  resource: ResourceMeta
  content: string
  snapshotId: string
}

/** 文档级上下文对话的上下文范围（由渲染层编辑器的选区/光标派生） */
export interface StreamContextRange {
  docId: string
  projectId: string
  before: number
  after: number
  anchor: number
  selectionFrom?: number
  selectionTo?: number
}

export interface StreamRequest {
  chatId: string
  requestId: string
  /** 用户本次输入正文 */
  userText: string
  /** 本次上传的资源快照 ID（主进程据此读取对话内部快照） */
  snapshotIds?: string[]
  /** 文档级上下文对话的上下文范围；项目级/文档级对话为空 */
  contextRange?: StreamContextRange
  /** 重新生成最近一条 AI 回答（PRD 6.6，替换最近回答并保留用户输入） */
  regenerate?: boolean
  /** 重新生成的原因：扩大了上下文范围 / 重新激活了摘要 / 两者皆有 */
  regenerateReason?: 'context' | 'summary' | 'both'
  /** 重新生成时新激活的摘要注入键（'doc:<id>' / 'chat:<id>' / 'res:<id>'） */
  newlyEnabledSummaries?: string[]
  userMessageId: string
}

export interface StreamDonePayload {
  chatId: string
  requestId: string
  content: string
  error?: string
  aborted?: boolean
  /** 思维链（推理模型的 reasoning_content） */
  reasoning?: string
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

export interface StreamChunkPayload {
  chatId: string
  requestId: string
  delta: string
  /** 思维链增量 */
  reasoningDelta?: string
}

export interface RecoveryState {
  projectId?: string
  docId?: string
  chatId?: string
  timestamp: string
  summaryFailed?: boolean
}

export interface ConnectionTestResult {
  ok: boolean
  message: string
}

export interface ExternalFileResult {
  ok: boolean
  error?: string
  projectId?: string
  resourceId?: string
  name?: string
  content?: string
  created?: boolean
}

export interface ExportProjectOptions {
  includeChats: boolean
  includeResources: boolean
  includeArchives: boolean
  includeSummaries: boolean
  includeGit: boolean
}
