import { AppConfig, SummaryInjectionConfig } from '@shared/types'
import { configPath } from '../paths'
import { atomicWriteJson, readJson } from '../util'

const DEFAULT_INJECTION: SummaryInjectionConfig = {
  project: { docSummaries: true, chatSummaries: true, resourceSummaries: true },
  doc: { fullText: true, docChatSummaries: true, otherDocSummaries: true, resourceSummaries: true },
  context: { docSummaries: true, docChatSummaries: true, resourceSummaries: true }
}

const DEFAULT_CONFIG: Omit<AppConfig, 'workspaceDir'> = {
  autosaveIntervalMs: 5000,
  summaryEnabled: true,
  gitEnabled: false,
  model: 'gpt-4o',
  apiBaseUrl: 'https://api.openai.com/v1',
  contextLimit: 256000,
  summaryInjection: DEFAULT_INJECTION
}

let cache: AppConfig | null = null

function mergeInjection(stored?: Partial<SummaryInjectionConfig>): SummaryInjectionConfig {
  return {
    project: { ...DEFAULT_INJECTION.project, ...(stored?.project ?? {}) },
    doc: { ...DEFAULT_INJECTION.doc, ...(stored?.doc ?? {}) },
    context: { ...DEFAULT_INJECTION.context, ...(stored?.context ?? {}) }
  }
}

export async function loadConfig(): Promise<AppConfig> {
  if (cache) return cache
  const stored = await readJson<Partial<AppConfig>>(configPath())
  cache = {
    ...DEFAULT_CONFIG,
    workspaceDir: '',
    ...(stored ?? {}),
    summaryInjection: mergeInjection(stored?.summaryInjection)
  }
  return cache
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

/** 判断工作目录是否已初始化（PRD 2.1 首次启动必须指定） */
export async function hasWorkspace(): Promise<boolean> {
  const cfg = await loadConfig()
  return cfg.workspaceDir.trim().length > 0
}
