import { loadConfig } from './config.service'
import { loadApiKey } from './crypto.service'

export interface ApiSettings {
  baseURL: string
  apiKey: string | null
  model: string
  contextLimit: number
  /** 界面语言：决定 LLM 回答与各类摘要的输出语言 */
  language: 'zh' | 'en'
}

/** 组合 API 配置与解密后的 Key（仅主进程内部使用，不暴露给渲染层） */
export async function loadApiSettings(): Promise<ApiSettings> {
  const cfg = await loadConfig()
  const apiKey = await loadApiKey()
  return {
    baseURL: cfg.apiBaseUrl,
    apiKey,
    model: cfg.model,
    contextLimit: cfg.contextLimit,
    language: cfg.language ?? 'zh'
  }
}
