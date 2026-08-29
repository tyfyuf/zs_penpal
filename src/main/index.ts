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

const ALLOWED_EXT = ['.txt', '.md', '.csv']

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
    await initErrorLog()
    await initializeSummaryJobManager()
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
        await flushRenderer()
        await commitAllProjects()
        await shutdownSummaryJobManager(8000)
      } catch {
        // 关闭阶段错误不阻塞退出
      } finally {
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

/** 请求渲染层立即保存未落盘的编辑器内容，超时 1.5s 兜底 */
function flushRenderer(): Promise<void> {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return Promise.resolve()
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(), 1500)
    ipcMain.once('app:flushed', () => {
      clearTimeout(timeout)
      resolve()
    })
    win.webContents.send('app:flush')
  })
}
