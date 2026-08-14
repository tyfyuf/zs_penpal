import { safeStorage } from 'electron'
import { readFile } from 'fs/promises'
import { apiKeyPath } from '../paths'
import { atomicWrite } from '../util'

/**
 * API Key 本地加密存储（PRD 1.3 / C4）：
 * 使用 Electron safeStorage（Windows 走 DPAPI），密文写入 userData/api-key.enc，
 * 不进入项目目录、不进入 Git。渲染层只读取“是否已配置”，不返回明文。
 */
export async function setApiKey(key: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统加密（DPAPI）不可用，无法安全存储 API Key')
  }
  const encrypted = safeStorage.encryptString(key)
  await atomicWrite(apiKeyPath(), encrypted.toString('base64'))
}

export async function loadApiKey(): Promise<string | null> {
  try {
    const b64 = await readFile(apiKeyPath(), 'utf8')
    if (!safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(Buffer.from(b64, 'base64'))
  } catch {
    return null
  }
}

export async function hasApiKey(): Promise<boolean> {
  const key = await loadApiKey()
  return !!key && key.trim().length > 0
}
