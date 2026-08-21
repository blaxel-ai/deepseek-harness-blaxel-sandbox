/** Blaxel implementation of the DSH filesystem capability seam. */
import { createHash, randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import {
  FileSystem,
  FsError,
  FsTargetKey,
  FsVersion,
} from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { BlaxelRuntime } from './runtime-service.js'
import { shellQuote } from './runtime-service.js'

declare module '@deepseek-ai/cordis' {
  interface Context { blaxel: BlaxelRuntime }
}

const MAX_SAMPLE = 8192

function assertNotAborted(signal: AbortSignal | undefined, op: string): void {
  if (signal?.aborted) throw new FsError(`${op} aborted`, 'FS_ABORTED')
}

function normalize(value: string): string { return value.replaceAll('\r\n', '\n') }

function versionFor(path: string, type: string, size: number, mtime: string): FsVersion {
  return FsVersion(`blaxel:${createHash('sha256').update(`${path}\0${type}\0${size}\0${mtime}`).digest('hex')}`)
}

function mapError(error: unknown, operation: string, path: string, signal?: AbortSignal): FsError {
  if (error instanceof FsError) return error
  if (signal?.aborted) return new FsError(`${operation} aborted`, 'FS_ABORTED', { cause: error })
  const text = String(error)
  if (/not found|no such file|404/i.test(text)) return new FsError(`cannot ${operation} "${path}": not found`, 'FS_NOT_FOUND', { cause: error })
  if (/permission denied|operation not permitted/i.test(text)) return new FsError(`cannot ${operation} "${path}": permission denied`, 'FS_PERMISSION_DENIED', { cause: error })
  return new FsError(`cannot ${operation} "${path}": ${text}`, 'FS_IO_ERROR', { cause: error })
}

function parseStat(raw: string, path: string, follow: boolean): FsPathInfo | undefined {
  const value = raw.trim()
  if (value === '') return undefined
  const [typeRaw, sizeRaw, mtime, inode, device] = value.split('|')
  const type = typeRaw === 'regular file' ? 'file' : typeRaw === 'directory' ? 'directory' : typeRaw === 'symbolic link' ? 'symlink' : 'other'
  const size = Number(sizeRaw)
  return {
    type: follow && type === 'symlink' ? 'other' : type,
    ...(Number.isFinite(size) && type === 'file' ? { size } : {}),
    version: versionFor(path, `${type}:${inode}:${device}`, size, mtime),
  }
}

async function command(runtime: BlaxelRuntime, text: string, cwd: string, signal?: AbortSignal): Promise<string> {
  assertNotAborted(signal, 'command')
  const sandbox = await runtime.getSandbox()
  const result = await sandbox.process.exec({ command: text, workingDir: cwd, waitForCompletion: true })
  assertNotAborted(signal, 'command')
  if (result.exitCode !== 0) throw new Error(result.stderr || result.logs || `remote command exited ${result.exitCode}`)
  return result.stdout ?? ''
}

export class BlaxelFileSystem extends FileSystem {
  static inject = ['blaxel']
  private readonly locks = new Map<string, Promise<void>>()

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    assertNotAborted(opts?.signal, 'resolve')
    if (path.trim() === '') throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const displayPath = this.remotePath(path, opts?.cwd)
    // Blaxel's filesystem API is path-addressed. Keep the normalized POSIX
    // path as the opaque target key; no host path is ever consulted.
    return { targetKey: FsTargetKey(displayPath), displayPath }
  }

  override processPath(target: FsTarget): string { return String(target.targetKey) }

  override fileUrl(target: FsTarget): string {
    return `file://${this.processPath(target).split('/').map(part => encodeURIComponent(part)).join('/')}`
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const relative = posix.relative(this.processPath(parent), this.processPath(child))
    return relative === '' || (!relative.startsWith('../') && relative !== '..' && !posix.isAbsolute(relative))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const info = await this.probe(this.processPath(target), target.displayPath, true, signal)
    return info === undefined ? undefined : { ...info, type: info.type === 'symlink' ? 'other' : info.type }
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    assertNotAborted(signal, 'lstat')
    const displayPath = this.remotePath(path, opts?.cwd)
    return this.probe(displayPath, displayPath, false, signal)
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const bytes = await this.readRaw(target, signal)
    if (bytes.subarray(0, MAX_SAMPLE).includes(0)) throw new FsError(`cannot read "${target.displayPath}": binary file`, 'FS_NOT_TEXT')
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch (error) {
      throw new FsError(`cannot read "${target.displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
    }
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const text = await this.readText(target, signal)
    return { async *[Symbol.asyncIterator]() { if (text) yield text } }
  }

  async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const bytes = await this.readRaw(target, signal)
    if (bytes.byteLength > maxBytes) throw new FsError(`cannot read "${target.displayPath}": content exceeds ${maxBytes} bytes`, 'FS_IO_ERROR')
    return bytes
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    assertNotAborted(signal, 'list')
    const sandbox = await this.ctx.blaxel.getSandbox()
    try {
      const listed = await sandbox.fs.ls(this.processPath(target))
      const entries: FsDirEntry[] = []
      for (const file of listed.files ?? []) {
        const child = await this.resolve(posix.join(target.displayPath, file.name), { cwd: '/' })
        const info = await this.stat(child, signal)
        entries.push({ name: file.name, type: 'file', target: child, version: info?.version, size: file.size })
      }
      for (const dir of listed.subdirectories ?? []) {
        const child = await this.resolve(posix.join(target.displayPath, dir.name), { cwd: '/' })
        const info = await this.stat(child, signal)
        entries.push({ name: dir.name, type: 'directory', target: child, version: info?.version })
      }
      return entries.sort((a, b) => a.name.localeCompare(b.name))
    } catch (error) { throw mapError(error, 'list', target.displayPath, signal) }
  }

  override async writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal): Promise<FsWriteOutcome> {
    return this.withLock(target.targetKey as string, async () => {
      assertNotAborted(signal, 'write')
      const beforeInfo = await this.stat(target, signal)
      if (expected?.kind === 'createIfAbsent' && beforeInfo !== undefined) throw new FsError(`cannot write "${target.displayPath}": target exists`, 'FS_NOT_OBSERVED')
      if (expected?.kind === 'replaceIfVersion' && (beforeInfo === undefined || beforeInfo.version !== expected.version)) throw new FsError(`cannot write "${target.displayPath}": stale version`, 'FS_STALE_VERSION')
      let before: string | null = null
      if (beforeInfo?.type === 'file') { try { before = normalize(await this.readText(target, signal)) } catch { before = null } }
      const sandbox = await this.ctx.blaxel.getSandbox()
      const parent = posix.dirname(this.processPath(target))
      await sandbox.fs.mkdir(parent)
      const temporary = `${this.processPath(target)}.dsh-blaxel-${randomUUID()}`
      await sandbox.fs.write(temporary, content)
      await command(this.ctx.blaxel, `mv -f -- ${shellQuote(temporary)} ${shellQuote(this.processPath(target))}`, this.ctx.blaxel.cwd, signal)
      const afterInfo = await this.stat(target, signal)
      if (afterInfo === undefined) throw new FsError(`cannot write "${target.displayPath}": write did not publish`, 'FS_IO_ERROR')
      return { operation: beforeInfo === undefined ? 'create' : 'update', version: afterInfo.version, before, after: normalize(content) }
    })
  }

  override async editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal): Promise<FsEditOutcome> {
    return this.withLock(target.targetKey as string, async () => {
      const info = await this.stat(target, signal)
      if (info === undefined) throw new FsError(`cannot edit "${target.displayPath}": not found`, 'FS_NOT_FOUND')
      if (expected !== undefined && info.version !== expected.version) throw new FsError(`cannot edit "${target.displayPath}": stale version`, 'FS_STALE_VERSION')
      const before = normalize(await this.readText(target, signal))
      if (edit.oldString.length === 0) throw new FsError('old_string must be non-empty', 'FS_EDIT_NOT_FOUND')
      const old = normalize(edit.oldString)
      const matches = before.split(old).length - 1
      if (matches === 0) throw new FsError(`cannot edit "${target.displayPath}": old_string was not found`, 'FS_EDIT_NOT_FOUND')
      if (!edit.replaceAll && matches !== 1) throw new FsError(`cannot edit "${target.displayPath}": old_string matched ${matches} times`, 'FS_AMBIGUOUS_EDIT')
      const after = edit.replaceAll ? before.split(old).join(normalize(edit.newString)) : before.replace(old, normalize(edit.newString))
      const outcome = await this.writeText(target, after, { kind: 'replaceIfVersion', version: info.version }, signal)
      return { before, after, version: outcome.version }
    })
  }

  private remotePath(path: string, cwd?: string): string {
    const mappedPath = this.ctx.blaxel.toRemotePath(path)
    if (mappedPath !== path || posix.isAbsolute(mappedPath)) return posix.resolve(mappedPath)
    const base = this.ctx.blaxel.toRemotePath(cwd ?? this.ctx.blaxel.cwd)
    return posix.resolve(base, mappedPath)
  }

  private async readRaw(target: FsTarget, signal?: AbortSignal): Promise<Uint8Array> {
    assertNotAborted(signal, 'read')
    try {
      const blob = await (await this.ctx.blaxel.getSandbox()).fs.readBinary(this.processPath(target))
      const bytes = new Uint8Array(await blob.arrayBuffer())
      assertNotAborted(signal, 'read')
      return bytes
    } catch (error) { throw mapError(error, 'read', target.displayPath, signal) }
  }

  private async probe(path: string, displayPath: string, follow: boolean, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    try {
      const flags = follow ? '-Lc' : '-c'
      const output = await command(this.ctx.blaxel, `stat ${flags} '%F|%s|%y|%i|%d' -- ${shellQuote(path)}`, this.ctx.blaxel.cwd, signal)
      return parseStat(output, displayPath, follow)
    } catch (error) {
      if (/not found|no such file|cannot stat/i.test(String(error))) return undefined
      throw mapError(error, 'stat', displayPath, signal)
    }
  }

  private async withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve()
    const current = prior.then(task, task)
    const release = current.then(() => undefined, () => undefined)
    this.locks.set(key, release)
    try { return await current } finally { if (this.locks.get(key) === release) this.locks.delete(key) }
  }
}

export default BlaxelFileSystem
