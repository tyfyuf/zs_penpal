import { existsSync } from 'fs'
import { delimiter, join } from 'path'
import { loadConfig } from '../services/config.service'
import { portableGitDir } from '../paths'

/** 在系统 PATH 中查找可执行文件（不依赖 child_process） */
function findInPath(bin: string): string | null {
  const pathEnv = process.env.PATH ?? ''
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const p = join(dir, bin + ext)
      if (existsSync(p)) return p
    }
  }
  return null
}

/**
 * Git 二进制解析顺序（tech-stack 6.5 / 2.7）：
 * 1. app-config.json 记录的 gitBinaryPath
 * 2. 系统 PATH
 * 3. userData/portable-git/cmd/git.exe
 */
export async function resolveGitBinary(): Promise<string | null> {
  const cfg = await loadConfig()
  if (cfg.gitBinaryPath && existsSync(cfg.gitBinaryPath)) return cfg.gitBinaryPath

  const fromPath = findInPath('git')
  if (fromPath) return fromPath

  const portable = join(portableGitDir(), 'cmd', 'git.exe')
  if (existsSync(portable)) return portable

  return null
}
