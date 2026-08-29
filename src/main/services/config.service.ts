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
  apiProtocol: 'chat_completions',
  contextLimit: 256000,
  summaryInjection: DEFAULT_INJECTION,
  language: 'zh'
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

/** 鍒ゆ柇宸ヤ綔鐩綍鏄惁宸插垵濮嬪寲锛圥RD 2.1 棣栨鍚姩蹇呴』鎸囧畾锛?*/
export async function hasWorkspace(): Promise<boolean> {
  const cfg = await loadConfig()
  return cfg.workspaceDir.trim().length > 0
}
