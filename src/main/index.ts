import { app, BrowserWindow, ipcMain } from 'electron'
import { setUserDataDir } from './paths'
import { loadConfig } from './services/config.service'
import { registerIpcHandlers } from './ipc'
import { createMainWindow, getMainWindow } from './window'
import { EVENTS } from '@shared/ipc'
import { commitAllProjects } from './services/git.service'
import { initializeSummaryJobManager, shutdownSummaryJobManager } from './services/summary-job-manager'
import { clearRecovery } from './services/recovery.service'
import { initErrorLog, logError } from './services/log.service'
import { disposeNeuralEmbedder } from './services/neural-embed.service'
import { initializeDocSummaryMaintenance, shutdownDocSummaryMaintenance } from './services/doc-summary-maintenance.service'
import { ensureFeatureGuideProject } from './services/file.service'

const ALLOWED_EXT = ['.txt', '.md', '.csv', '.doc', '.docx']

// Keep development windows grouped under Penpal instead of Electron on Windows.
// This ID matches the public Penpal package identity.
if (process.platform === 'win32') {
  app.setName('Penpal')
  app.setAppUserModelId('com.penpal.app')
}

// 全局错误落盘（供维护查阅）
process.on('uncaughtException', (err) => {
  logError('main:uncaughtException', err.message, err.stack)
})
process.on('unhandledRejection', (reason) => {
  logError(
    'main:unhandledRejection',
    reason instanceof Error ? reason.message : String(reason),
    reason instanceof Error ? reason.stack : undefined
  )
})

function findExternalFile(argv: string[]): string | null {
  return argv.find((a) => ALLOWED_EXT.some((ext) => a.toLowerCase().endsWith(ext))) ?? null
}

// 单实例锁（PRD 1.5）：第二实例静默退出，路径转交第一实例
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  let isQuitting = false

  app.on('second-instance', (_event, argv) => {
    const win = getMainWindow()
    if (!win) return
    const filePath = findExternalFile(argv)
    if (filePath) {
      win.webContents.send(EVENTS.openExternalFile, filePath)
    }
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.flashFrame(true)
  })

  // 文件关联：作为第一实例启动时携带的路径（Windows 通过 argv 传入）
  let pendingExternalFile: string | null = findExternalFile(process.argv.slice(1))

  app.whenReady().then(async () => {
    setUserDataDir(app.getPath('userData'))
    await loadConfig()
    try { await ensureFeatureGuideProject(false) } catch { /* no workspace yet or guide was deliberately deleted */ }
    await initErrorLog()
    await initializeSummaryJobManager()
    await initializeDocSummaryMaintenance()
    registerIpcHandlers()

    const win = createMainWindow()
    win.webContents.on('did-finish-load', () => {
      if (pendingExternalFile) {
        win.webContents.send(EVENTS.openExternalFile, pendingExternalFile)
        pendingExternalFile = null
      }
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })

  app.on('open-file', (event, path) => {
    event.preventDefault()
    pendingExternalFile = path
  })

  // 退出：先让渲染层落盘，再提交 Git、等待摘要队列，最后清除恢复标记
  app.on('before-quit', (event) => {
    if (isQuitting) return
    event.preventDefault()
    isQuitting = true

    void (async () => {
      try {
        const flushed = await flushRenderer()
        if (!flushed) {
          isQuitting = false
          return
        }
        await commitAllProjects()
        shutdownDocSummaryMaintenance()
        await shutdownSummaryJobManager(8000)
      } catch {
        // 关闭阶段错误不阻塞退出
      } finally {
        if (!isQuitting) return
        await disposeNeuralEmbedder()
        await clearRecovery()
        app.exit(0)
      }
    })()
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}

/** 请求渲染层立即保存未落盘的编辑器内容，超时 10s 后中止退出 */
function flushRenderer(): Promise<boolean> {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      ipcMain.removeListener('app:flushed', onFlushed)
      resolve(result)
    }
    const onFlushed = (_event: Electron.IpcMainEvent, payload?: { ok?: boolean }): void => {
      finish(payload?.ok !== false)
    }
    const timeout = setTimeout(() => finish(false), 10000)
    ipcMain.on('app:flushed', onFlushed)
    try {
      win.webContents.send('app:flush')
    } catch {
      finish(false)
    }
  })
}
