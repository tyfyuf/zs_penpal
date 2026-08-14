import { execFile } from 'child_process'
import { createWriteStream, existsSync, readFileSync } from 'fs'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import { createHash } from 'crypto'
import { promisify } from 'util'
import { loadConfig, setConfig } from '../services/config.service'
import { portableGitDir } from '../paths'
import { resolveGitBinary } from './git-resolver'

const execFileAsync = promisify(execFile)

export interface GitResult {
  ok: boolean
  path?: string
  reason?: 'declined' | 'manual-required' | 'failed'
}

// 默认 PortableGit 版本（可通过 app-config.json 的 git.portableVersion 覆盖）
const DEFAULT_PORTABLE_VERSION = '2.47.1.windows.2'
const PORTABLE_ARTIFACT = (version: string): string =>
  `PortableGit-${version.replace(/\.windows\.\d+$/, '')}-64-bit.7z.exe`

async function hasWinget(): Promise<boolean> {
  try {
    await execFileAsync('winget', ['--version'], { timeout: 15_000 })
    return true
  } catch {
    return false
  }
}

async function tryWinget(): Promise<boolean> {
  if (!(await hasWinget())) return false
  try {
    await execFileAsync(
      'winget',
      ['install', 'Git.Git', '--silent', '--accept-package-agreements', '--accept-source-agreements'],
      { timeout: 300_000 }
    )
    return (await resolveGitBinary()) !== null
  } catch {
    return false
  }
}

async function downloadPortableGit(version: string, destDir: string): Promise<string> {
  const artifact = PORTABLE_ARTIFACT(version)
  const url = `https://github.com/git-for-windows/git/releases/download/v${version}/${artifact}`
  const dest = join(destDir, artifact)
  if (existsSync(dest)) return dest

  await mkdir(destDir, { recursive: true })
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`)
  const file = createWriteStream(dest)
  const reader = res.body.getReader()
  const writeChunk = async (): Promise<void> => {
    const { done, value } = await reader.read()
    if (done) return
    await new Promise<void>((resolve, reject) =>
      file.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()))
    )
    await writeChunk()
  }
  await writeChunk()
  await new Promise<void>((resolve, reject) => file.end((err?: Error | null) => (err ? reject(err) : resolve())))
  return dest
}

function verifySha256(file: string, expected?: string): boolean {
  if (!expected) return true
  const hash = createHash('sha256').update(readFileSync(file)).digest('hex')
  return hash.toLowerCase() === expected.toLowerCase()
}

async function tryPortableGit(): Promise<boolean> {
  try {
    const cfg = await loadConfig()
    const version = (cfg as unknown as { git?: { portableVersion?: string } }).git?.portableVersion ?? DEFAULT_PORTABLE_VERSION
    const sha = (cfg as unknown as { git?: { portableSha256?: string } }).git?.portableSha256
    const destDir = portableGitDir()
    const archive = await downloadPortableGit(version, destDir)
    if (!verifySha256(archive, sha)) {
      return false
    }
    await execFileAsync(archive, [`-o${destDir}`, '-y'], { timeout: 300_000 })
    const p = join(destDir, 'cmd', 'git.exe')
    if (existsSync(p)) {
      await setConfig({ gitBinaryPath: p })
      return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * Git 三级降级安装（T-1 / PRD 2.7）：
 * L1 winget → L2 PortableGit 自解压 → L3 手动提示
 */
export async function ensureGit(consent: boolean): Promise<GitResult> {
  const existing = await resolveGitBinary()
  if (existing) return { ok: true, path: existing }

  if (!consent) return { ok: false, reason: 'declined' }

  // L1：winget
  if (await tryWinget()) {
    const p = await resolveGitBinary()
    if (p) return { ok: true, path: p }
  }

  // L2：PortableGit
  if (await tryPortableGit()) {
    const p = await resolveGitBinary()
    if (p) return { ok: true, path: p }
  }

  // L3：手动
  return { ok: false, reason: 'manual-required' }
}
