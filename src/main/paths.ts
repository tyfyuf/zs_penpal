import { app } from 'electron'
import { join } from 'path'

/** 缓存 userData 目录（在 app ready 后调用 setUserDataDir 初始化） */
let userDataDir = ''

export function setUserDataDir(dir: string): void {
  userDataDir = dir
}

export function getUserDataDir(): string {
  return userDataDir || app.getPath('userData')
}

export function configPath(): string {
  return join(getUserDataDir(), 'app-config.json')
}

export function apiKeyPath(): string {
  return join(getUserDataDir(), 'api-key.enc')
}

export function usageDir(): string {
  return join(getUserDataDir(), 'usage')
}

export function recoveryPath(): string {
  return join(getUserDataDir(), 'recovery.json')
}

export function portableGitDir(): string {
  return join(getUserDataDir(), 'portable-git')
}
