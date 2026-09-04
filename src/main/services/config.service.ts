import { AppConfig, SummaryInjectionConfig } from '@shared/types'
import { configPath } from '../paths'
import { atomicWriteJson, readJson } from '../util'

const DEFAULT_INJECTION: SummaryInjectionConfig = {
  project: { basic: 5, dynamic: 10, docSummaries: true, chatSummaries: true, resourceSummaries: true },
  doc: { basic: 10, dynamic: 10, fullText: true, docChatSummaries: true, otherDocSummaries: true, resourceSummaries: true },
  context: { basic: 10, dynamic: 10, docSummaries: true, docChatSummaries: true, resourceSummaries: true }
}

const DEFAULT_CONFIG: Omit<AppConfig, 'workspaceDir'> = {
  autosaveIntervalMs: 5000,
  summaryEnabled: true,
  gitEnabled: false,
  model: 'gpt-4o',
  apiBaseUrl: 'https://api.openai.com/v1',
  apiProtocol: 'chat_completions',
  contextLimit: 256000,
  summaryInjection: DEFAULT_INJECTION,
  language: 'zh'
}

let cache: AppConfig | null = null

function validLimit(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.max(min, Math.min(max, n))
}

function mergeInjection(stored?: Partial<SummaryInjectionConfig>): SummaryInjectionConfig {
  const source = stored as Record<string, any> | undefined
  const project = source?.project ?? {}
  const doc = source?.doc ?? {}
  const context = source?.context ?? {}
  return {
    project: {
      ...DEFAULT_INJECTION.project,
      ...project,
      basic: validLimit(project.basic, DEFAULT_INJECTION.project.basic, 5, 10),
      dynamic: validLimit(project.dynamic, DEFAULT_INJECTION.project.dynamic, 10, 20),
      docSummaries: project.docSummaries !== false,
      chatSummaries: project.chatSummaries !== false,
      resourceSummaries: project.resourceSummaries !== false
    },
    doc: {
      ...DEFAULT_INJECTION.doc,
      ...doc,
      basic: validLimit(doc.basic, DEFAULT_INJECTION.doc.basic, 10, 20),
      dynamic: validLimit(doc.dynamic, DEFAULT_INJECTION.doc.dynamic, 10, 20),
      fullText: doc.fullText !== false,
      docChatSummaries: doc.docChatSummaries !== false,
      otherDocSummaries: doc.otherDocSummaries !== false,
      resourceSummaries: doc.resourceSummaries !== false
    },
    context: {
      ...DEFAULT_INJECTION.context,
      ...context,
      basic: validLimit(context.basic, DEFAULT_INJECTION.context.basic, 10, 20),
      dynamic: validLimit(context.dynamic, DEFAULT_INJECTION.context.dynamic, 10, 20),
      docSummaries: context.docSummaries !== false,
      docChatSummaries: context.docChatSummaries !== false,
      resourceSummaries: context.resourceSummaries !== false
    }
  }
}

export async function loadConfig(): Promise<AppConfig> {
  if (cache) return cache
  const stored = await readJson<Partial<AppConfig>>(configPath())
  cache = {
    ...DEFAULT_CONFIG,
    workspaceDir: '',
    ...(stored ?? {}),
    apiProtocol: stored?.apiProtocol === 'responses' ? 'responses' : 'chat_completions',
    summaryInjection: mergeInjection(stored?.summaryInjection)
  }
  return cache
}

export function setConfigCache(config: AppConfig): void {
  cache = { ...config, summaryInjection: mergeInjection(config.summaryInjection) }
}

export function getConfigCached(): AppConfig {
  if (!cache) throw new Error('config not loaded')
  return cache
}

export async function setConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  const current = await loadConfig()
  cache = {
    ...current,
    ...patch,
    summaryInjection: patch.summaryInjection ? mergeInjection(patch.summaryInjection) : current.summaryInjection
  }
  await persist()
  return cache
}

async function persist(): Promise<void> {
  if (!cache) return
  await atomicWriteJson(configPath(), cache)
}

/** 判断工作目录是否已初始化（PRD 2.1 首次启动必须指定）*/
export async function hasWorkspace(): Promise<boolean> {
  const cfg = await loadConfig()
  return cfg.workspaceDir.trim().length > 0
}
