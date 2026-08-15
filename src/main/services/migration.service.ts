import { dirname, relative, resolve } from 'path'
import { cp, mkdir, readdir, rename, rm, stat } from 'fs/promises'
import { EVENTS } from '@shared/ipc'
import { loadConfig, setConfig } from './config.service'
import { commitAllProjects } from './git.service'
import { broadcast } from '../window'
import { newId } from '../util'

function isSubdir(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !resolve(rel).startsWith('..')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Windows 下 rename 目录到“已存在的目录”会报 EPERM：先移除空目标，再带退避重试改名 */
async function renameDirAtomically(staging: string, targetAbs: string): Promise<void> {
  // 目标已存在（校验阶段已确认其为空目录）→ 先移除
  const targetExists = await stat(targetAbs)
    .then(() => true)
    .catch(() => false)
  if (targetExists) {
    await rm(targetAbs, { recursive: true, force: true })
  }
  // EPERM 退避重试（杀毒软件等瞬时占用）
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(staging, targetAbs)
      return
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM' && attempt < 5) {
        await sleep(200 + attempt * 200)
        continue
      }
      throw err
    }
  }
}

async function countFiles(dir: string): Promise<number> {
  let n = 0
  let entries: string[] = []
  try {
    entries = await readdir(dir)
  } catch {
    return 0
  }
  for (const name of entries) {
    const st = await stat(resolve(dir, name)).catch(() => null)
    if (!st) continue
    if (st.isDirectory()) n += await countFiles(resolve(dir, name))
    else n += 1
  }
  return n
}

/**
 * 工作目录迁移（PRD 2.2 / tech-stack 8.9 / T-3）：
 * 物理复制（含完整 .git）到暂存目录，校验后原子生效，失败保持原目录可用。
 */
export async function migrateWorkspace(targetDir: string): Promise<{ ok: boolean; error?: string }> {
  const cfg = await loadConfig()
  const src = cfg.workspaceDir
  if (!src) return { ok: false, error: '当前未设置工作目录' }

  const srcAbs = resolve(src)
  const targetAbs = resolve(targetDir)

  if (targetAbs === srcAbs) return { ok: false, error: '目标与当前工作目录相同' }
  if (isSubdir(targetAbs, srcAbs)) return { ok: false, error: '目标不能是当前工作目录的子目录' }
  if (isSubdir(srcAbs, targetAbs)) return { ok: false, error: '目标不能包含当前工作目录' }

  // 目标必须不存在或为空
  try {
    const st = await stat(targetAbs)
    if (st.isDirectory()) {
      const entries = await readdir(targetAbs)
      if (entries.length > 0) return { ok: false, error: '目标目录已存在且非空' }
    }
  } catch {
    // 目标不存在，允许
  }

  broadcast(EVENTS.migrateProgress, { phase: 'prepare', message: '准备迁移…', percent: 5 })

  // 版本管理开启时先提交变更
  if (cfg.gitEnabled) {
    broadcast(EVENTS.migrateProgress, { phase: 'commit', message: '提交未保存的版本变更…', percent: 20 })
    await commitAllProjects()
  }

  // 物理复制到暂存目录
  const staging = resolve(dirname(targetAbs), `.vibewrite-migrate-${newId()}`)
  try {
    await mkdir(staging, { recursive: true })
    broadcast(EVENTS.migrateProgress, { phase: 'copy', message: '复制项目数据（含 Git 历史）…', percent: 40 })
    await cp(srcAbs, staging, { recursive: true })

    broadcast(EVENTS.migrateProgress, { phase: 'verify', message: '校验迁移结果…', percent: 85 })
    const srcCount = await countFiles(srcAbs)
    const dstCount = await countFiles(staging)
    if (srcCount !== dstCount) {
      throw new Error(`文件数校验不一致（源 ${srcCount}，目标 ${dstCount}）`)
    }

    // 原子生效（目标为已存在的空目录时先移除，EPERM 退避重试）
    await renameDirAtomically(staging, targetAbs)
    await setConfig({ workspaceDir: targetAbs })
    broadcast(EVENTS.migrateProgress, { phase: 'done', message: '迁移完成', percent: 100 })
    return { ok: true }
  } catch (err) {
    // 失败：清理暂存，原目录保持可用
    try {
      await rm(staging, { recursive: true, force: true })
    } catch {
      // 忽略清理失败
    }
    return { ok: false, error: (err as Error).message }
  }
}
