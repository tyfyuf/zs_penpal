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

/** 常见安装位置（winget/安装器默认路径，PATH 未刷新时也能找到） */
function findCommonInstall(): string | null {
  const candidates = [
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'cmd', 'git.exe'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'cmd', 'git.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'cmd', 'git.exe')
  ]
  for (const p of candidates) {
    if (p && existsSync(p)) return p
  }
  return null
}

/**
 * Git 二进制解析顺序（tech-stack 6.5 / 2.7）：
 * 1. app-config.json 记录的 gitBinaryPath
 * 2. 常见安装位置（PATH 未刷新的场景，如 winget 刚安装完）
 * 3. 系统 PATH
 * 4. userData/portable-git/cmd/git.exe
 */
export async function resolveGitBinary(): Promise<string | null> {
  const cfg = await loadConfig()
  if (cfg.gitBinaryPath && existsSync(cfg.gitBinaryPath)) return cfg.gitBinaryPath

  const common = findCommonInstall()
  if (common) return common

  const fromPath = findInPath('git')
  if (fromPath) return fromPath

  const portable = join(portableGitDir(), 'cmd', 'git.exe')
  if (existsSync(portable)) return portable

  return null
}
