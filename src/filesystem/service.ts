/** Blaxel implementation of the DSH filesystem capability seam. */
import { constants as bufferConstants } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { FileSystem, FsError, FsTargetKey } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { execChecked, execRaw } from '../runtime/exec.js'
import { shellQuote } from '../shared/shell.js'
import { detectsCrlf, literalEdit, normalizeLineEndings, restoreLineEndings } from './edit.js'
import { assertNotAborted, decodeText, mapError } from './errors.js'
import {
  DANGLING_SENTINEL,
  STAT_FORMAT,
  decodeCanonicalPath,
  infoType,
  parseBoundedReadTransport,
  parseListingTransport,
  parseStatTransport,
  versionFor,
  type RemoteStat,
} from './transport.js'

const DIFF_BASIS_MAX_BYTES = 10 * 1024 * 1024
const CONTROL_TIMEOUT_SECONDS = 60

/** Canonicalizes through the nearest existing ancestor on GNU and BusyBox images. */
function canonicalPathScript(path: string, framed: boolean): string {
  const output = framed ? `printf '%s\\0' "$dsh_real$dsh_suffix" | base64 -w0` : `printf '%s' "$dsh_real$dsh_suffix"`
  return [
    `dsh_path=${shellQuote(path)}`,
    "dsh_suffix=''",
    'dsh_realpath_error=$(mktemp) || exit 1',
    "trap 'rm -f \"$dsh_realpath_error\"' EXIT",
    'while ! dsh_real=$(realpath "$dsh_path" 2>"$dsh_realpath_error"); do',
    '  if ! grep -qi "No such file or directory" "$dsh_realpath_error"; then cat "$dsh_realpath_error" >&2; exit 1; fi',
    '  dsh_parent=${dsh_path%/*}',
    '  test -n "$dsh_parent" || dsh_parent=/',
    '  if test "$dsh_parent" = "$dsh_path"; then dsh_real="$dsh_path"; break; fi',
    '  dsh_base=${dsh_path##*/}',
    '  dsh_suffix="/$dsh_base$dsh_suffix"',
    '  dsh_path=$dsh_parent',
    'done',
    output,
  ].join('\n')
}

export class BlaxelFileSystem extends FileSystem {
  static inject = ['blaxel']
  private readonly locks = new Map<string, Promise<void>>()

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    assertNotAborted(opts?.signal, 'resolve')
    if (path.trim() === '') throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const displayPath = this.remotePath(path, opts?.cwd)
    try {
      const encoded = await this.run(`set -o pipefail\n${canonicalPathScript(displayPath, true)}`, opts?.signal)
      const targetKey = decodeCanonicalPath(encoded)
      assertNotAborted(opts?.signal, 'resolve')
      return { targetKey: FsTargetKey(targetKey), displayPath }
    } catch (error) {
      throw mapError(error, 'resolve', displayPath, opts?.signal)
    }
  }

  override processPath(target: FsTarget): string { return String(target.targetKey) }

  override fileUrl(target: FsTarget): string {
    const path = this.processPath(target)
    if (!posix.isAbsolute(path)) throw new Error(`dsh-blaxel: expected an absolute process path: ${JSON.stringify(path)}`)
    return `file://${path.split('/').map(part => encodeURIComponent(part)).join('/')}`
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const relative = posix.relative(this.processPath(parent), this.processPath(child))
    return relative === '' || (relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const path = this.processPath(target)
    const stat = await this.probe(path, target.displayPath, true, signal)
    if (stat === undefined) return undefined
    return {
      version: versionFor(path, stat),
      type: infoType(stat.type),
      ...(stat.type === 'file' ? { size: stat.size } : {}),
    }
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    assertNotAborted(signal, 'lstat')
    if (path.trim() === '') throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const displayPath = this.remotePath(path, opts?.cwd)
    const stat = await this.probe(displayPath, displayPath, false, signal)
    if (stat === undefined) return undefined
    return {
      version: versionFor(displayPath, stat),
      type: stat.type,
      ...(stat.type === 'file' ? { size: stat.size } : {}),
    }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    await this.requireRegular(target, 'read', signal)
    return decodeText(await this.readAfterCheck(target, 'read', signal), target.displayPath)
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    await this.requireRegular(target, 'read', signal)
    const read = () => this.readAfterCheck(target, 'read', signal)
    const displayPath = target.displayPath
    return { async *[Symbol.asyncIterator]() {
      const text = decodeText(await read(), displayPath)
      assertNotAborted(signal, 'read')
      if (text.length > 0) yield text
    } }
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= bufferConstants.MAX_LENGTH) {
      throw new FsError(`cannot read "${target.displayPath}": invalid byte limit`, 'FS_IO_ERROR')
    }
    const info = await this.requireRegular(target, 'read', signal)
    if (info.size !== undefined && info.size > maxBytes) {
      throw new FsError(`cannot read "${target.displayPath}": ${String(info.size)} bytes exceeds the ${String(maxBytes)}-byte limit`, 'FS_TOO_LARGE')
    }
    try {
      const transfer = posix.join(this.ctx.blaxel.runtimeRoot, 'reads', randomUUID())
      const encoded = await this.run([
        'set -o pipefail; set -e',
        `mkdir -p -- ${shellQuote(posix.dirname(transfer))}`,
        `transfer=${shellQuote(transfer)}`,
        `trap 'rm -f -- "$transfer"' EXIT`,
        `head -c ${String(maxBytes + 1)} -- ${shellQuote(this.processPath(target))} > "$transfer"`,
        'base64 -w0 -- "$transfer"',
        "printf '\\n'",
        'wc -c < "$transfer"',
      ].join('; '), signal)
      const bytes = parseBoundedReadTransport(encoded)
      if (bytes.byteLength > maxBytes) {
        throw new FsError(`cannot read "${target.displayPath}": content exceeds the ${String(maxBytes)}-byte limit`, 'FS_TOO_LARGE')
      }
      return bytes
    } catch (error) {
      throw mapError(error, 'read', target.displayPath, signal)
    }
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const info = await this.stat(target, signal)
    if (info === undefined) throw new FsError(`cannot list "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (info.type !== 'directory') throw new FsError(`cannot list "${target.displayPath}": not a directory`, 'FS_NOT_DIRECTORY')
    const statFormat = shellQuote(STAT_FORMAT)
    const canonical = canonicalPathScript('$dsh_entry', false).replace(`dsh_path=${shellQuote('$dsh_entry')}`, 'dsh_path=$dsh_entry')
    const script = [
      'set -o pipefail',
      'dsh_listing_error=$(mktemp) || exit 1',
      "trap 'rm -f \"$dsh_listing_error\"' EXIT",
      'dsh_canonical() {',
      ...canonical.split('\n').slice(0, -1).map(line => `  ${line}`),
      '  printf \'%s\' "$dsh_real$dsh_suffix"',
      '}',
      `find ${shellQuote(this.processPath(target))} -mindepth 1 -maxdepth 1 -print0 | while IFS= read -r -d '' dsh_entry; do`,
      `  dsh_stat=$(LC_ALL=C stat -c ${statFormat} "$dsh_entry") || exit 1`,
      "  printf '%s\\0%s\\0' \"$dsh_entry\" \"$dsh_stat\"",
      `  if dsh_followed=$(LC_ALL=C stat -L -c ${statFormat} "$dsh_entry" 2>"$dsh_listing_error"); then`,
      "    printf '%s\\0' \"$dsh_followed\"",
      '  elif test -L "$dsh_entry" && grep -q "No such file or directory" "$dsh_listing_error"; then',
      `    printf '${DANGLING_SENTINEL}\\0'`,
      '  else',
      '    cat "$dsh_listing_error" >&2',
      '    exit 1',
      '  fi',
      '  dsh_resolved=$(dsh_canonical "$dsh_entry") || exit 1',
      "  printf '%s\\0' \"$dsh_resolved\"",
      'done | base64 -w0',
    ].join('\n')
    try {
      const encoded = await this.run(script, signal)
      assertNotAborted(signal, 'list')
      return parseListingTransport(encoded, target)
    } catch (error) {
      throw mapError(error, 'list', target.displayPath, signal)
    }
  }

  override async writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal): Promise<FsWriteOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const existing = await this.probe(this.processPath(target), target.displayPath, true, signal)
      if (existing !== undefined && existing.type !== 'file') {
        throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      this.checkWriteIntent(existing, expected, target)
      const before = existing === undefined ? null : await this.readDiffBasis(target, existing, signal)
      const version = await this.writeAtomic(target, content, existing, expected?.kind === 'createIfAbsent', signal)
      return {
        operation: existing === undefined ? 'create' : 'update',
        version,
        before,
        after: normalizeLineEndings(content),
      }
    })
  }

  override async editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal): Promise<FsEditOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const path = this.processPath(target)
      const existing = await this.probe(path, target.displayPath, true, signal)
      if (existing === undefined) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      if (existing.type !== 'file') throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      if (expected !== undefined && versionFor(path, existing) !== expected.version) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      const bytes = await this.readAfterCheck(target, 'edit', signal)
      const raw = decodeText(bytes, target.displayPath, bytes.byteLength)
      const before = normalizeLineEndings(raw)
      const after = literalEdit(before, edit, target.displayPath)
      const storage = restoreLineEndings(after, detectsCrlf(raw))
      return {
        version: await this.writeAtomic(target, storage, existing, false, signal),
        before,
        after,
      }
    })
  }

  /** Runs one bounded control command in the sandbox and returns its stdout. */
  private async run(command: string, signal?: AbortSignal, label = 'fs'): Promise<string> {
    assertNotAborted(signal, 'command')
    const sandbox = await this.ctx.blaxel.getSandbox()
    const stdout = await execChecked(sandbox, {
      label,
      command,
      cwd: this.ctx.blaxel.cwd,
      timeoutSeconds: CONTROL_TIMEOUT_SECONDS,
    })
    assertNotAborted(signal, 'command')
    return stdout
  }

  private remotePath(path: string, cwd?: string): string {
    const mappedPath = this.ctx.blaxel.toRemotePath(path)
    if (mappedPath !== path || posix.isAbsolute(mappedPath)) return posix.resolve(mappedPath)
    const base = this.ctx.blaxel.toRemotePath(cwd ?? this.ctx.blaxel.cwd)
    return posix.resolve(base, mappedPath)
  }

  private async probe(path: string, displayPath: string, follow: boolean, signal?: AbortSignal): Promise<RemoteStat | undefined> {
    assertNotAborted(signal, 'stat')
    const flags = follow ? '-L ' : ''
    try {
      const output = await this.run(
        `set -o pipefail; LC_ALL=C stat ${flags}-c ${shellQuote(STAT_FORMAT)} ${shellQuote(path)} | base64 -w0`,
        signal,
      )
      return parseStatTransport(output)
    } catch (error) {
      if (/no such file or directory|not a directory/i.test(String(error))) return undefined
      throw mapError(error, 'stat', displayPath, signal)
    }
  }

  private async requireRegular(target: FsTarget, operation: string, signal?: AbortSignal): Promise<FsInfo> {
    const info = await this.stat(target, signal)
    if (info === undefined) throw new FsError(`cannot ${operation} "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (info.type !== 'file') throw new FsError(`cannot ${operation} "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    return info
  }

  private async readAfterCheck(target: FsTarget, operation: string, signal?: AbortSignal): Promise<Uint8Array> {
    assertNotAborted(signal, operation)
    try {
      const blob = await (await this.ctx.blaxel.getSandbox()).fs.readBinary(this.processPath(target))
      const bytes = new Uint8Array(await blob.arrayBuffer())
      assertNotAborted(signal, operation)
      return bytes
    } catch (error) {
      throw mapError(error, operation, target.displayPath, signal)
    }
  }

  private checkWriteIntent(existing: RemoteStat | undefined, expected: FsWriteIntent | undefined, target: FsTarget): void {
    if (expected?.kind === 'createIfAbsent' && existing !== undefined) {
      throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
    }
    if (expected?.kind === 'replaceIfVersion') {
      const version = existing === undefined ? undefined : versionFor(this.processPath(target), existing)
      if (version !== expected.version) {
        throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
    }
  }

  private async readDiffBasis(target: FsTarget, existing: RemoteStat, signal?: AbortSignal): Promise<string | null> {
    if (existing.size >= DIFF_BASIS_MAX_BYTES) return null
    try {
      const bytes = await this.readBytes(target, signal, DIFF_BASIS_MAX_BYTES - 1)
      return normalizeLineEndings(decodeText(bytes, target.displayPath, bytes.byteLength))
    } catch (error) {
      if (error instanceof FsError && (error.code === 'FS_NOT_TEXT' || error.code === 'FS_TOO_LARGE')) return null
      throw error
    }
  }

  /**
   * Publishes through a private sibling directory so a reader never sees a
   * half-written file, and a committed write is never reported as failed
   * because its cleanup failed afterwards.
   */
  private async writeAtomic(
    target: FsTarget,
    content: string,
    existing: RemoteStat | undefined,
    createIfAbsent: boolean,
    signal?: AbortSignal,
  ): Promise<FsVersion> {
    assertNotAborted(signal, 'write')
    const sandbox = await this.ctx.blaxel.getSandbox()
    const targetPath = this.processPath(target)
    const parent = posix.dirname(targetPath)
    const stagingDirectory = posix.join(parent, `.dsh-${randomUUID()}.tmp`)
    const temporary = posix.join(stagingDirectory, 'content')
    let stagingCreated = false
    try {
      await this.run(`mkdir -p -- ${shellQuote(parent)} && mkdir -m 700 -- ${shellQuote(stagingDirectory)}`, signal, 'fs-control')
      stagingCreated = true
      assertNotAborted(signal, 'write')
      await sandbox.fs.write(temporary, content)
      const mode = existing === undefined ? 0o600 : existing.mode & 0o777
      await this.run(`chmod ${mode.toString(8)} -- ${shellQuote(temporary)}`, signal, 'fs-control')
      assertNotAborted(signal, 'write')
      const staged = await this.probe(temporary, target.displayPath, true, signal)
      if (staged === undefined || staged.type !== 'file') throw new Error('staged content disappeared before publication')
      if (createIfAbsent) {
        const published = (await this.run(
          `if ln -T -- ${shellQuote(temporary)} ${shellQuote(targetPath)} 2>/dev/null; then printf created; elif test -e ${shellQuote(targetPath)} || test -L ${shellQuote(targetPath)}; then printf exists; else exit 1; fi`,
        )).trim()
        if (published === 'exists') {
          throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
        }
        if (published !== 'created') throw new Error('guarded create returned an invalid publication result')
      } else {
        await this.run(`mv -T -- ${shellQuote(temporary)} ${shellQuote(targetPath)}`, signal, 'fs-control')
      }
      const version = versionFor(targetPath, staged)
      await this.discardStaging(stagingDirectory)
      return version
    } catch (error) {
      if (stagingCreated) await this.discardStaging(stagingDirectory)
      throw mapError(error, 'write', target.displayPath, signal)
    }
  }

  private async discardStaging(path: string): Promise<void> {
    const sandbox = await this.ctx.blaxel.getSandbox().catch(() => undefined)
    if (sandbox === undefined) return
    await execRaw(sandbox, {
      label: 'fs-cleanup',
      command: `rm -rf -- ${shellQuote(path)}`,
      cwd: this.ctx.blaxel.cwd,
      timeoutSeconds: CONTROL_TIMEOUT_SECONDS,
    }).catch(() => undefined)
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
