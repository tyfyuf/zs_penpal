import { loadConfig } from './config.service'
import type { ApiProtocol } from '@shared/types'
import { loadApiKey } from './crypto.service'

export interface ApiSettings {
  baseURL: string
  apiProtocol: ApiProtocol
  apiKey: string | null
  model: string
  contextLimit: number
  /** 界面语言：决定 LLM 回答与各类摘要的输出语言 */
  language: 'zh' | 'en'
}

/**
 * Worker 运行时覆盖：摘要 Worker 不读取/解密 API Key，而是由主进程通过私有进程 IPC 注入当前配置。
 * 主进程不设置该覆盖，因此保留原有 safeStorage 行为。
 */
let runtimeOverride: ApiSettings | null = null

export function setRuntimeApiSettings(settings: ApiSettings): void {
  runtimeOverride = { ...settings }
}

export function clearRuntimeApiSettings(): void {
  runtimeOverride = null
}

/** 读取当前 API 配置；Worker 中优先使用主进程注入的运行时配置。 */
export async function loadApiSettings(): Promise<ApiSettings> {
  if (runtimeOverride) return { ...runtimeOverride }
  const cfg = await loadConfig()
  const apiKey = await loadApiKey()
  return {
    baseURL: cfg.apiBaseUrl,
    apiProtocol: cfg.apiProtocol ?? 'chat_completions',
    apiKey,
    model: cfg.model,
    contextLimit: cfg.contextLimit,
    language: cfg.language ?? 'zh'
  }
}
