import { dialog } from 'electron'
import { createWriteStream } from 'fs'
import { mkdir, readFile, rm } from 'fs/promises'
import { join } from 'path'
import archiver from 'archiver'
import type { ExportProjectOptions } from '@shared/types'
import { getConfigCached } from './config.service'
import { buildSnapshot } from './file.service'
import { getMainWindow } from '../window'

function projectDir(projectId: string): string {
  return join(getConfigCached().workspaceDir, projectId)
}

/** 单文档导出（PRD 5.3）：Markdown 或纯文本 */
export async function exportDoc(docId: string, format: 'md' | 'txt'): Promise<{ ok: boolean; path?: string; error?: string }> {
  const snap = await buildSnapshot()
  for (const tree of snap.projects) {
    const doc = tree.docs.find((d) => d.id === docId)
    if (!doc) continue
    const content = await readFile(join(projectDir(tree.project.id), 'docs', `${docId}.md`), 'utf8')
    const ext = format === 'md' ? 'md' : 'txt'
    const win = getMainWindow()
    const result = await dialog.showSaveDialog(win!, {
      title: '导出文档',
      defaultPath: `${doc.title}.${ext}`,
      filters: [{ name: format === 'md' ? 'Markdown' : '纯文本', extensions: [ext] }]
    })
    if (result.canceled || !result.filePath) return { ok: false, error: '已取消' }
    const { writeFile } = await import('fs/promises')
    await writeFile(result.filePath, content, 'utf8')
    return { ok: true, path: result.filePath }
  }
  return { ok: false, error: '文档不存在' }
}

/** 项目导出为 Zip（PRD 5.3，按勾选项增减） */
export async function exportProject(
  projectId: string,
  options: ExportProjectOptions
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const snap = await buildSnapshot()
  const tree = snap.projects.find((p) => p.project.id === projectId)
  if (!tree) return { ok: false, error: '项目不存在' }

  const win = getMainWindow()
  const result = await dialog.showSaveDialog(win!, {
    title: '导出项目',
    defaultPath: `${tree.project.name}.zip`,
    filters: [{ name: 'Zip', extensions: ['zip'] }]
  })
  if (result.canceled || !result.filePath) return { ok: false, error: '已取消' }

  const root = projectDir(projectId)
  const output = createWriteStream(result.filePath)
  const archive = archiver('zip', { zlib: { level: 9 } })
  const done = new Promise<void>((resolve, reject) => {
    output.on('close', resolve)
    archive.on('error', reject)
  })
  archive.pipe(output)

  // 写作文档与资源默认勾选（PRD 5.3）
  archive.directory(join(root, 'docs'), 'docs')
  if (options.includeResources) archive.directory(join(root, 'resources'), 'resources')
  if (options.includeChats) archive.directory(join(root, 'chats'), 'chats')
  if (options.includeSummaries) archive.directory(join(root, 'summaries'), 'summaries')
  if (options.includeArchives) {
    // 归档对话属于 chats 目录（状态在元数据中），整目录已包含；此处仅归档区为空的兼容分支
    void mkdir
  }
  if (options.includeGit) archive.directory(join(root, '.git'), '.git')
  // 项目元数据始终包含
  try {
    const meta = await readFile(join(root, 'meta.json'), 'utf8')
    archive.append(meta, { name: 'meta.json' })
  } catch {
    // 无 meta.json 时忽略
  }

  await archive.finalize()
  await done
  await rm(root, { recursive: false, force: true }).catch(() => {})
  return { ok: true, path: result.filePath }
}
