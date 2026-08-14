import { AppConfig } from '@shared/types'
import { configPath } from '../paths'
import { atomicWriteJson, readJson } from '../util'

const DEFAULT_CONFIG: Omit<AppConfig, 'workspaceDir'> = {
  autosaveIntervalMs: 5000,
  summaryEnabled: true,
  gitEnabled: false,
  model: 'gpt-4o',
  apiBaseUrl: 'https://api.openai.com/v1',
  contextLimit: 256000
}

let cache: AppConfig | null = null

export async function loadConfig(): Promise<AppConfig> {
  if (cache) return cache
  const stored = await readJson<Partial<AppConfig>>(configPath())
  cache = {
    ...DEFAULT_CONFIG,
    workspaceDir: '',
    ...(stored ?? {})
  }
  return cache
}

export function getConfigCached(): AppConfig {
  if (!cache) throw new Error('config not loaded')
  return cache
}

export async function setConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  const current = await loadConfig()
  cache = { ...current, ...patch }
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
