import { rm } from 'fs/promises'
import type { RecoveryState } from '@shared/types'
import { recoveryPath } from '../paths'
import { atomicWriteJson, readJson } from '../util'

/**
 * 异常退出恢复（PRD 1.6 / tech-stack 8.7）：
 * 启动时写入恢复标记，正常关闭时清除；下次启动检测到则提示恢复。
 */
export async function updateRecovery(state: RecoveryState): Promise<void> {
  await atomicWriteJson(recoveryPath(), state)
}

export async function readRecovery(): Promise<RecoveryState | null> {
  return readJson<RecoveryState>(recoveryPath())
}

export async function clearRecovery(): Promise<void> {
  await rm(recoveryPath(), { force: true })
}
