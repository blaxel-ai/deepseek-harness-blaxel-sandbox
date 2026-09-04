import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { lstat, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { posix } from 'node:path'
import { promisify } from 'node:util'
import type { ProgressReport } from './launch-progress.js'

const execFileAsync = promisify(execFile)
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024
const MAX_FILES = 100_000
const MAX_SOURCE_BYTES = 512 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
const MAX_META_CHARS = 16 * 1024
const SAFE_EXAMPLE = /(?:^|[._-])(?:example|sample|template|fixture|test)(?:[._-]|$)/i
const PRIVATE_KEY = /\.(?:key|pem|p12|pfx|jks)$/i
const PRIVATE_NAME = /^(?:\.env(?:\..+)?|\.npmrc|\.pypirc|\.netrc|auth\.json|credentials\.json|secrets\.json|service-account(?:\.[^.]+)?\.json|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$/i
const PRIVATE_DIRS = new Set(['.ssh', '.aws', '.azure', '.gnupg'])
/** The sandbox keeps its own state here, so a repository may never seed it. */
const RUNTIME_DIR = '.dsh-blaxel'

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
  archiveBytes: number
  branch?: string
  commit?: string
}

/** Snapshot provenance handed to the Blaxel process, which has no repository. */
export interface SnapshotMeta {
  repoRoot: string
  cwd: string
  remoteCwd: string
  fileCount: number
  skippedSensitive: number
  archiveBytes: number
  branch?: string
  commit?: string
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
    throw new Error('The workspace must be a directory inside a Git worktree', { cause: error })
  }
}

/** Reads one Git fact without failing the launch when it is unavailable. */
async function gitFact(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 })
    const value = stdout.trim()
    return value === '' ? undefined : value
  } catch {
    return undefined
  }
}

export async function inspectGitWorkspace(inputCwd: string): Promise<GitWorkspace> {
  if (inputCwd.length === 0 || inputCwd.includes('\0') || !isAbsolute(inputCwd)) {
    throw new Error('The workspace directory must be an absolute path')
  }
  const cwd = await realpath(resolve(inputCwd)).catch(() => {
    throw new Error('The current workspace directory no longer exists')
  })
  if (!(await lstat(cwd)).isDirectory()) throw new Error('The workspace path must be a directory')
  if ((await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() !== 'true') {
    throw new Error('The workspace must be a directory inside a Git worktree')
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
  if (segments.some(segment => segment === '.git' || segment === RUNTIME_DIR || PRIVATE_DIRS.has(segment.toLowerCase()))) return true
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

/**
 * `-v` names every archived entry on stderr, which is also where an archiver
 * error lands. Counting those lines is what lets the local window show files
 * going into the snapshot instead of an unexplained wait; the tail is still
 * kept verbatim so a failure reports what tar actually said.
 */
async function createTar(root: string, archivePath: string, paths: string[], report?: ProgressReport): Promise<void> {
  const input = Buffer.from(paths.length === 0 ? '' : `${paths.map(path => `./${path}`).join('\0')}\0`)
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('tar', ['-C', root, '-czvf', archivePath, '--null', '--no-recursion', '-T', '-'], {
      // macOS bsdtar otherwise serializes extended attributes as AppleDouble
      // `._*` files, which become ordinary source files after Linux extraction.
      env: { ...process.env, COPYFILE_DISABLE: '1' },
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    let stderr = ''
    let archived = 0
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      stderr = (stderr + text).slice(-16_384)
      const named = text.split('\n').length - 1
      if (named === 0 || report === undefined) return
      archived = Math.min(paths.length, archived + named)
      report({ step: 'archiving', archived })
    })
    child.once('error', error => reject(new Error('Could not start the workspace snapshot archiver', { cause: error })))
    child.once('exit', code => {
      if (code === 0) resolvePromise()
      else reject(new Error(`Could not snapshot the Git worktree${stderr.trim() === '' ? '' : `: ${lastLine(stderr)}`}`))
    })
    child.stdin.end(input)
  })
}

/** The archiver's own last word, past the entry names `-v` prints before it. */
function lastLine(stderr: string): string {
  const lines = stderr.trimEnd().split('\n')
  return (lines.at(-1) ?? '').trim()
}

export async function createGitWorkspaceSnapshot(workspace: GitWorkspace, report?: ProgressReport): Promise<GitWorkspaceSnapshot> {
  report?.({ step: 'listing' })
  const listed = (await git(workspace.repoRoot, ['ls-files', '--cached', '--others', '--exclude-standard', '--deduplicate', '-z']))
    .split('\0')
    .filter(Boolean)
  if (listed.length > MAX_FILES) throw new Error(`The Git worktree contains more than ${String(MAX_FILES)} snapshot files`)

  const paths: string[] = []
  let sourceBytes = 0
  let skippedSensitive = 0
  report?.({ step: 'screening', total: listed.length, screened: 0, included: 0, skipped: 0 })
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
    report?.({
      step: 'screening',
      total: listed.length,
      screened: Math.min(listed.length, offset + batch.length),
      included: paths.length,
      skipped: skippedSensitive,
    })
  }

  const branch = await gitFact(workspace.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const commit = await gitFact(workspace.repoRoot, ['rev-parse', 'HEAD'])
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-blaxel-'))
  const archivePath = join(tempDir, 'workspace.tar.gz')
  try {
    report?.({ step: 'archiving', total: listed.length, included: paths.length, archived: 0 })
    await createTar(workspace.repoRoot, archivePath, paths, report)
    const archiveBytes = (await stat(archivePath)).size
    report?.({ step: 'archiving', archived: paths.length, archiveBytes })
    if (archiveBytes > MAX_ARCHIVE_BYTES) throw new Error('The compressed Git worktree snapshot exceeds 256 MiB')
    return {
      ...workspace,
      archivePath,
      tempDir,
      fileCount: paths.length,
      skippedSensitive,
      archiveBytes,
      ...(branch === undefined ? {} : { branch: branch === 'HEAD' ? 'DETACHED' : branch }),
      ...(commit === undefined ? {} : { commit }),
    }
  } catch (error) {
    await rm(tempDir, { force: true, recursive: true })
    throw error
  }
}

/** Serializes snapshot provenance for DSH_BLAXEL_SNAPSHOT_META. */
export function snapshotMetaEnv(snapshot: GitWorkspaceSnapshot): string {
  const meta: SnapshotMeta = {
    repoRoot: snapshot.repoRoot,
    cwd: snapshot.cwd,
    remoteCwd: snapshot.remoteCwd,
    fileCount: snapshot.fileCount,
    skippedSensitive: snapshot.skippedSensitive,
    archiveBytes: snapshot.archiveBytes,
    ...(snapshot.branch === undefined ? {} : { branch: snapshot.branch }),
    ...(snapshot.commit === undefined ? {} : { commit: snapshot.commit }),
  }
  return JSON.stringify(meta)
}

function boundedText(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= limit ? value : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** Validates the provenance env var; the environment is a process boundary. */
export function parseSnapshotMeta(raw: string | undefined): SnapshotMeta | undefined {
  if (raw === undefined || raw.length === 0 || raw.length > MAX_META_CHARS) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  const repoRoot = boundedText(record.repoRoot, 4096)
  const cwd = boundedText(record.cwd, 4096)
  const remoteCwd = boundedText(record.remoteCwd, 4096)
  const fileCount = count(record.fileCount)
  const skippedSensitive = count(record.skippedSensitive)
  const archiveBytes = count(record.archiveBytes)
  if (repoRoot === undefined || cwd === undefined || remoteCwd === undefined) return undefined
  if (fileCount === undefined || skippedSensitive === undefined || archiveBytes === undefined) return undefined
  const branch = boundedText(record.branch, 256)
  const commit = boundedText(record.commit, 256)
  return {
    repoRoot,
    cwd,
    remoteCwd,
    fileCount,
    skippedSensitive,
    archiveBytes,
    ...(branch === undefined ? {} : { branch }),
    ...(commit === undefined ? {} : { commit }),
  }
}

export async function removeGitWorkspaceSnapshot(snapshot: Pick<GitWorkspaceSnapshot, 'tempDir'>): Promise<void> {
  await rm(snapshot.tempDir, { force: true, recursive: true })
}
