import { simpleGit, type SimpleGit } from 'simple-git'
import { join } from 'path'
import type { GitCommitInfo } from '@shared/types'
import { getConfigCached } from './config.service'
import { resolveGitBinary } from '../install/git-resolver'
import { listProjects } from './file.service'

function projectDir(projectId: string): string {
  return join(getConfigCached().workspaceDir, projectId)
}

async function getGit(projectId: string): Promise<SimpleGit> {
  const binary = await resolveGitBinary()
  if (!binary) throw new Error('未检测到 Git，请先在设置中开启版本管理并安装')
  return simpleGit({ baseDir: projectDir(projectId) }).customBinary(binary)
}

/** 确保项目拥有独立 Git 仓库（PRD 2.3） */
export async function ensureProjectRepo(projectId: string): Promise<void> {
  const git = await getGit(projectId)
  const isRepo = await git.checkIsRepo()
  if (!isRepo) {
    await git.init()
  }
}

/** 自动提交（PRD 2.5）：正常关闭时按项目检测变更并提交 */
export async function commitProject(projectId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!getConfigCached().gitEnabled) return { ok: false, error: '版本管理未开启' }
    await ensureProjectRepo(projectId)
    const git = await getGit(projectId)
    await git.add(['-A'])
    const status = await git.status()
    if (status.files.length === 0) return { ok: true }
    await git.commit(`auto: ${new Date().toISOString()}`)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** 提交所有存在变更的项目（关闭软件时，PRD 2.5） */
export async function commitAllProjects(): Promise<void> {
  if (!getConfigCached().gitEnabled) return
  const projects = await listProjects('normal')
  for (const p of projects) {
    await commitProject(p.id)
  }
}

export async function gitLog(projectId: string): Promise<GitCommitInfo[]> {
  const git = await getGit(projectId)
  const isRepo = await git.checkIsRepo()
  if (!isRepo) return []
  const log = await git.log({ maxCount: 100 })
  return log.all.map((c) => ({
    hash: c.hash,
    date: c.date,
    message: c.message,
    author: c.author_name
  }))
}

/**
 * 回滚项目到指定提交（PRD 2.6）。
 * 使用 reset --hard 恢复该提交时的完整文件状态（仅限项目目录内，不含 API Key 等全局配置）。
 */
export async function rollback(projectId: string, hash: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const git = await getGit(projectId)
    await git.reset(['--hard', hash])
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
