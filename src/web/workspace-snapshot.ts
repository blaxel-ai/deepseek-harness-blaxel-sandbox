import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { lstat, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { posix } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024
const MAX_FILES = 100_000
const MAX_SOURCE_BYTES = 512 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
const SAFE_EXAMPLE = /(?:^|[._-])(?:example|sample|template|fixture|test)(?:[._-]|$)/i
const PRIVATE_KEY = /\.(?:key|pem|p12|pfx|jks)$/i
const PRIVATE_NAME = /^(?:\.env(?:\..+)?|\.npmrc|\.pypirc|\.netrc|auth\.json|credentials\.json|secrets\.json|service-account(?:\.[^.]+)?\.json|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$/i
const PRIVATE_DIRS = new Set(['.ssh', '.aws', '.azure', '.gnupg'])

export interface GitWorkspace {
  cwd: string
  repoRoot: string
  relativeCwd: string
  remoteCwd: string
}

export interface GitWorkspaceSnapshot extends GitWorkspace {
  archivePath: string
  tempDir: string
  fileCount: number
  skippedSensitive: number
}

function inside(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate)
  return suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix))
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    })
    return stdout
  } catch (error) {
    throw new Error('Open in Blaxel requires a directory inside a Git worktree', { cause: error })
  }
}

export async function inspectGitWorkspace(inputCwd: string): Promise<GitWorkspace> {
  if (inputCwd.length === 0 || inputCwd.includes('\0') || !isAbsolute(inputCwd)) {
    throw new Error('Open in Blaxel requires an absolute workspace directory')
  }
  const cwd = await realpath(resolve(inputCwd)).catch(() => {
    throw new Error('The current workspace directory no longer exists')
  })
  if (!(await lstat(cwd)).isDirectory()) throw new Error('Open in Blaxel requires a workspace directory')
  if ((await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() !== 'true') {
    throw new Error('Open in Blaxel requires a directory inside a Git worktree')
  }
  const repoRoot = await realpath((await git(cwd, ['rev-parse', '--show-toplevel'])).trim())
  if (!inside(repoRoot, cwd)) throw new Error('The current directory is outside the resolved Git worktree')
  const relativeCwd = relative(repoRoot, cwd)
  const remoteCwd = relativeCwd === ''
    ? '/workspace'
    : posix.join('/workspace', ...relativeCwd.split(sep))
  return { cwd, repoRoot, relativeCwd, remoteCwd }
}

function sensitivePath(path: string): boolean {
  const segments = path.split('/')
  if (segments.some(segment => segment === '.git' || PRIVATE_DIRS.has(segment.toLowerCase()))) return true
  const name = basename(path)
  if (SAFE_EXAMPLE.test(name)) return false
  return PRIVATE_NAME.test(name) || PRIVATE_KEY.test(name)
}

async function safeEntry(root: string, path: string): Promise<{ include: boolean; bytes: number }> {
  if (path.length === 0 || path.includes('\0') || isAbsolute(path)) return { include: false, bytes: 0 }
  const normalized = path.split('/').join(sep)
  if (normalized.split(sep).includes('..')) return { include: false, bytes: 0 }
  const full = join(root, normalized)
  let info
  try {
    info = await lstat(full)
  } catch {
    return { include: false, bytes: 0 }
  }
  if (!info.isFile() && !info.isSymbolicLink() && !info.isDirectory()) return { include: false, bytes: 0 }
  const containmentTarget = info.isSymbolicLink() ? await realpath(dirname(full)) : await realpath(full)
  if (!inside(root, containmentTarget)) return { include: false, bytes: 0 }
  return { include: true, bytes: info.isFile() ? info.size : 0 }
}

async function createTar(root: string, archivePath: string, paths: string[]): Promise<void> {
  const input = Buffer.from(paths.length === 0 ? '' : `${paths.map(path => `./${path}`).join('\0')}\0`)
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('tar', ['-C', root, '-czf', archivePath, '--null', '--no-recursion', '-T', '-'], {
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-16_384)
    })
    child.once('error', error => reject(new Error('Could not start the workspace snapshot archiver', { cause: error })))
    child.once('exit', code => {
      if (code === 0) resolvePromise()
      else reject(new Error(`Could not snapshot the Git worktree${stderr.trim() === '' ? '' : `: ${stderr.trim()}`}`))
    })
    child.stdin.end(input)
  })
}

export async function createGitWorkspaceSnapshot(workspace: GitWorkspace): Promise<GitWorkspaceSnapshot> {
  const listed = (await git(workspace.repoRoot, ['ls-files', '--cached', '--others', '--exclude-standard', '--deduplicate', '-z']))
    .split('\0')
    .filter(Boolean)
  if (listed.length > MAX_FILES) throw new Error(`The Git worktree contains more than ${String(MAX_FILES)} snapshot files`)

  const paths: string[] = []
  let sourceBytes = 0
  let skippedSensitive = 0
  for (let offset = 0; offset < listed.length; offset += 128) {
    const batch = listed.slice(offset, offset + 128)
    const checked = await Promise.all(batch.map(async path => {
      if (sensitivePath(path)) return { path, sensitive: true, include: false, bytes: 0 }
      const result = await safeEntry(workspace.repoRoot, path)
      return { path, sensitive: false, ...result }
    }))
    for (const entry of checked) {
      if (entry.sensitive) skippedSensitive += 1
      if (!entry.include) continue
      sourceBytes += entry.bytes
      if (sourceBytes > MAX_SOURCE_BYTES) throw new Error('The Git worktree snapshot exceeds 512 MiB')
      paths.push(entry.path)
    }
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-blaxel-'))
  const archivePath = join(tempDir, 'workspace.tar.gz')
  try {
    await createTar(workspace.repoRoot, archivePath, paths)
    if ((await stat(archivePath)).size > MAX_ARCHIVE_BYTES) throw new Error('The compressed Git worktree snapshot exceeds 256 MiB')
    return { ...workspace, archivePath, tempDir, fileCount: paths.length, skippedSensitive }
  } catch (error) {
    await rm(tempDir, { force: true, recursive: true })
    throw error
  }
}

export async function removeGitWorkspaceSnapshot(snapshot: Pick<GitWorkspaceSnapshot, 'tempDir'>): Promise<void> {
  await rm(snapshot.tempDir, { force: true, recursive: true })
}
