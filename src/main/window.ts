import { app, BrowserWindow, shell } from 'electron'
import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { getConfigCached } from './services/config.service'

let mainWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null

/**
 * Resolve the branded window icon in both development and packaged builds.
 * electron-builder's buildResources directory is not part of app.asar, so
 * packaged builds receive the runtime copies through extraResources.
 */
function getWindowIconPath(): string | undefined {
  const fileName = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  const candidates = [
    // Packaged build: electron-builder copies the icon to resources/.
    join(process.resourcesPath, fileName),
    // Development build: __dirname points at out/main/chunks after bundling.
    resolve(__dirname, '../../build', fileName),
    join(process.cwd(), 'build', fileName)
  ]

  // Summary workers run as Electron Utility Processes. They can load modules
  // shared with the main process, but do not expose electron.app. Keep the
  // app-specific candidate optional so worker startup never depends on it.
  if (app && typeof app.getAppPath === 'function') {
    candidates.push(join(app.getAppPath(), 'build', fileName))
  }

  return candidates.find((candidate) => existsSync(candidate))
}

const windowIconPath = getWindowIconPath()

function windowTitle(): string {
  try {
    return getConfigCached().language === 'en' ? 'Penpal' : '笔伴'
  } catch {
    return '笔伴'
  }
}

export function createMainWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: windowTitle(),
    ...(windowIconPath ? { icon: windowIconPath } : {}),
    backgroundColor: '#0b0f14',
    webPreferences: {
      preload: resolve(__dirname, '../../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  if (windowIconPath && process.platform === 'win32') {
    mainWindow.setIcon(windowIconPath)
  }

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
    closeSettingsWindow()
  })

  // 外部链接交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(resolve(__dirname, '../../renderer/index.html'))
  }

  return mainWindow
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

/** 主进程 → 渲染进程事件推送 */
export function broadcast(channel: string, payload: unknown): void {
  for (const win of [mainWindow, settingsWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }
}


export function openSettingsWindow(): BrowserWindow {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show()
    settingsWindow.focus()
    return settingsWindow
  }

  settingsWindow = new BrowserWindow({
    width: 980,
    height: 720,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    center: true,
    show: false,
    autoHideMenuBar: true,
    title: '\u8bbe\u7f6e - Penpal',
    ...(windowIconPath ? { icon: windowIconPath } : {}),
    backgroundColor: '#0b0f14',
    parent: mainWindow ?? undefined,
    webPreferences: {
      preload: resolve(__dirname, '../../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  if (windowIconPath && process.platform === 'win32') {
    settingsWindow.setIcon(windowIconPath)
  }

  settingsWindow.on('ready-to-show', () => settingsWindow?.show())
  settingsWindow.on('closed', () => {
    settingsWindow = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void settingsWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}#settings`)
  } else {
    void settingsWindow.loadFile(resolve(__dirname, '../../renderer/index.html'), { hash: 'settings' })
  }

  return settingsWindow
}

export function closeSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close()
  settingsWindow = null
}

export function getSettingsWindow(): BrowserWindow | null {
  return settingsWindow
}
