import { dirname, relative, resolve } from 'path'
import { cp, lstat, mkdir, readdir, realpath, rename, rm } from 'fs/promises'
import { EVENTS } from '@shared/ipc'
import { loadConfig, setConfig } from './config.service'
import { commitAllProjects } from './git.service'
import { broadcast } from '../window'
import { newId } from '../util'

function isSubdir(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !resolve(rel).startsWith('..')
}

/**
 * Migration commits only by renaming into a non-existent target. Existing user paths are never removed or overwritten.
 * This closes the check-then-delete TOCTOU window that could destroy a target file.
 */
async function renameDirAtomically(staging: string, targetAbs: string): Promise<void> {
  await rename(staging, targetAbs)
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

async function nearestExistingParent(path: string): Promise<string | null> {
  let current = dirname(path)
  while (true) {
    try {
      const info = await lstat(current)
      return info.isDirectory() && !info.isSymbolicLink() ? current : null
    } catch {
      const parent = dirname(current)
      if (parent === current) return null
      current = parent
    }
  }
}

async function assertSafeMigrationPaths(srcAbs: string, targetAbs: string): Promise<void> {
  const sourceInfo = await lstat(srcAbs).catch(() => null)
  if (!sourceInfo || !sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
    throw new Error('当前工作目录不存在、不是目录或是符号链接')
  }
  const sourceReal = await realpath(srcAbs)
  const targetInfo = await lstat(targetAbs).catch(() => null)
  if (targetInfo) {
    throw new Error('目标路径已存在；为避免覆盖或删除用户文件，请选择一个不存在的目录路径')
  }
  const targetParent = await nearestExistingParent(targetAbs)
  if (!targetParent) throw new Error('目标路径的父目录不存在或不是安全的目录')
  const targetParentInfo = await lstat(targetParent)
  if (!targetParentInfo.isDirectory() || targetParentInfo.isSymbolicLink()) {
    throw new Error('目标路径的父目录不是安全的真实目录')
  }
  const targetParentReal = await realpath(targetParent)
  const targetCanonical = resolve(targetParentReal, relative(targetParent, targetAbs))
  if (samePath(targetCanonical, sourceReal) || isSubdir(targetCanonical, sourceReal) || isSubdir(sourceReal, targetCanonical)) {
    throw new Error('目标路径不能与当前工作目录重叠')
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
    const st = await lstat(resolve(dir, name)).catch(() => null)
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
let migrationInFlight = false

export async function migrateWorkspace(targetDir: string): Promise<{ ok: boolean; error?: string }> {
  if (migrationInFlight) return { ok: false, error: '工作区迁移正在进行中，请稍候再试' }
  migrationInFlight = true
  try {
    const cfg = await loadConfig()
    const src = cfg.workspaceDir
    if (!src) return { ok: false, error: '当前未设置工作目录' }

    const srcAbs = resolve(src)
    const targetAbs = resolve(targetDir)
    if (samePath(targetAbs, srcAbs)) return { ok: false, error: '目标与当前工作目录相同' }

    try {
      await assertSafeMigrationPaths(srcAbs, targetAbs)
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }

    broadcast(EVENTS.migrateProgress, { phase: 'prepare', message: '准备迁移…', percent: 5 })

    if (cfg.gitEnabled) {
      broadcast(EVENTS.migrateProgress, { phase: 'commit', message: '提交未保存的版本变更…', percent: 20 })
      await commitAllProjects()
    }

    const staging = resolve(dirname(targetAbs), `.penpal-migrate-${newId()}`)
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

      const targetInfo = await lstat(targetAbs).catch(() => null)
      if (targetInfo) throw new Error('迁移提交前目标路径已被创建，已安全中止')
      await renameDirAtomically(staging, targetAbs)
      await setConfig({ workspaceDir: targetAbs })
      broadcast(EVENTS.migrateProgress, { phase: 'done', message: '迁移完成', percent: 100 })
      return { ok: true }
    } catch (err) {
      try {
        await rm(staging, { recursive: true, force: true })
      } catch {
        // Keep the original workspace usable; a later startup cleanup can handle a leftover staging directory.
      }
      return { ok: false, error: (err as Error).message }
    }
  } finally {
    migrationInFlight = false
  }
}
