/** Bounded divergence reports between the restored workspace and its baseline. */
import { Buffer } from 'node:buffer'
import { baselineGit } from '../runtime/baseline.js'
import { execRaw } from '../runtime/exec.js'
import type { BlaxelRuntime } from '../runtime/service.js'
import { shellQuote } from '../shared/shell.js'
import { decodeBase64Text } from '../shared/transport.js'

const CACHE_TTL_MS = 8_000
const EXEC_TIMEOUT_MS = 25_000
const MAX_FILES = 500
const MAX_STATUS_BYTES = 512 * 1024
const MAX_PATCH_BYTES = 1024 * 1024
const SHORTSTAT = /(?:(\d+) insertions?\(\+\))?(?:, )?(?:(\d+) deletions?\(-\))?\s*$/
/** `head -c` closes the pipe once the cap is reached, which SIGPIPEs git. */
const SIGPIPE_EXIT = 141
/** Exit codes the report script reserves for its own two git steps. */
const STATUS_FAILED_EXIT = 3
const DIFF_FAILED_EXIT = 4

export interface DivergenceFile {
  status: string
  path: string
  from?: string
}

export interface DivergenceSummary {
  changed: number
  files: DivergenceFile[]
  truncated: boolean
  insertions?: number
  deletions?: number
  checkedAt: string
}

export type DivergenceResult =
  | { available: true; divergence: DivergenceSummary }
  | { available: false; reason: string }

export interface DivergencePatch {
  commit: string
  text: string
  bytes: number
  truncated: boolean
  checkedAt: string
}

/** Parses `git status --porcelain=v1 -z`, where renames carry a second field. */
export function parsePorcelainStatus(raw: string, maxFiles = MAX_FILES): Omit<DivergenceSummary, 'checkedAt'> {
  const entries = raw.split('\0')
  const files: DivergenceFile[] = []
  let changed = 0
  let truncated = false
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry === undefined || entry.length < 4) continue
    const status = entry.slice(0, 2)
    const path = entry.slice(3)
    let from: string | undefined
    if (status.startsWith('R') || status.startsWith('C')) {
      const original = entries[index + 1]
      index += 1
      if (original !== undefined && original.length > 0) from = original
    }
    changed += 1
    if (files.length < maxFiles) files.push({ status, path, ...(from === undefined ? {} : { from }) })
    else truncated = true
  }
  return { changed, files, truncated }
}

/** Reads `git diff --shortstat`; both counters are absent when nothing changed. */
export function parseShortStat(line: string): { insertions?: number; deletions?: number } {
  const match = SHORTSTAT.exec(line.trim())
  const insertions = match?.[1] === undefined ? undefined : Number(match[1])
  const deletions = match?.[2] === undefined ? undefined : Number(match[2])
  return {
    ...(insertions === undefined ? {} : { insertions }),
    ...(deletions === undefined ? {} : { deletions }),
  }
}

/** Caps patch text on a line boundary and reports whether anything was cut. */
export function boundPatchText(text: string, maxBytes = MAX_PATCH_BYTES): Omit<DivergencePatch, 'commit' | 'checkedAt'> {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= maxBytes) return { text, bytes, truncated: false }
  const cut = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')
  const lastNewline = cut.lastIndexOf('\n')
  const kept = lastNewline > 0 ? cut.slice(0, lastNewline + 1) : cut
  return { text: kept, bytes: Buffer.byteLength(kept, 'utf8'), truncated: true }
}

/**
 * Reads the report script's three lines: the capped base64 listing, the true
 * byte length of that listing, and the shortstat line. A listing cut short is
 * reported as truncated instead of being counted as the whole truth.
 */
export function summarizeReport(stdout: string, maxStatusBytes = MAX_STATUS_BYTES): DivergenceSummary {
  const [encoded = '', total = '', ...rest] = stdout.split('\n')
  const listing = decodeReport(encoded, 'divergence')
  const bytes = Number.parseInt(total.trim(), 10)
  if (!Number.isSafeInteger(bytes) || bytes < Buffer.byteLength(listing, 'utf8')) {
    throw new Error('The sandbox returned a partial divergence report')
  }
  const cut = bytes > maxStatusBytes
  // A cut listing ends mid-entry; only whole NUL-terminated records count.
  const whole = cut ? listing.slice(0, listing.lastIndexOf('\0') + 1) : listing
  const parsed = parsePorcelainStatus(whole)
  return {
    ...parsed,
    truncated: parsed.truncated || cut,
    ...parseShortStat(rest.join('\n')),
    checkedAt: new Date().toISOString(),
  }
}

/** Transport faults are the user's problem to retry, not a stack trace. */
function decodeReport(encoded: string, label: string): string {
  try {
    return decodeBase64Text(encoded, label)
  } catch (error) {
    throw new Error(`The sandbox returned an unreadable ${label} report`, { cause: error })
  }
}

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replaceAll(/\s+/g, ' ').trim().slice(0, 240)
}

async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${String(Math.round(ms / 1000))} seconds`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Runs the divergence commands inside the sandbox. Results are cached for a few
 * seconds so the status poll never pays for them, both payloads are capped in
 * the sandbox pipeline rather than in host memory, and each report runs one at a
 * time. Git-ignored paths stay out of every report because the baseline honours
 * the restored `.gitignore`.
 */
export class BlaxelDivergence {
  private cached: { at: number; result: DivergenceResult } | undefined
  private reading: Promise<DivergenceResult> | undefined
  private patching: Promise<DivergencePatch> | undefined

  constructor(private readonly runtime: BlaxelRuntime) {}

  /** The last result while it is still fresh; computes nothing. */
  fresh(): DivergenceResult | undefined {
    if (this.cached === undefined) return undefined
    return Date.now() - this.cached.at <= CACHE_TTL_MS ? this.cached.result : undefined
  }

  /** One report at a time, so repeated clicks cannot stack sandbox work. */
  async read(): Promise<DivergenceResult> {
    const fresh = this.fresh()
    if (fresh !== undefined) return fresh
    this.reading ??= this.computeReport().finally(() => { this.reading = undefined })
    return await this.reading
  }

  async patch(): Promise<DivergencePatch> {
    this.patching ??= this.computePatch().finally(() => { this.patching = undefined })
    return await this.patching
  }

  private async computeReport(): Promise<DivergenceResult> {
    const baseline = this.runtime.baselineState()
    if (!baseline.ready) return this.remember({ available: false, reason: baseline.reason })
    const pair = baselineGit(this.runtime.paths)
    const statusFile = shellQuote(`${this.runtime.runtimeRoot}/divergence.status`)
    const statFile = shellQuote(`${this.runtime.runtimeRoot}/divergence.shortstat`)
    try {
      const stdout = await this.exec('divergence', [
        'set -o pipefail',
        // Intent-to-add makes files created in the sandbox visible to both the
        // listing and the patch, and expands directories to their own entries.
        `${pair} add -A -N >/dev/null 2>&1 || true`,
        `${pair} status --porcelain=v1 -z -uall > ${statusFile} || exit ${String(STATUS_FAILED_EXIT)}`,
        `${pair} diff --shortstat ${shellQuote(baseline.commit)} > ${statFile} || exit ${String(DIFF_FAILED_EXIT)}`,
        `head -c ${String(MAX_STATUS_BYTES)} ${statusFile} | base64 -w0`,
        `printf '\\n%s\\n' "$(wc -c < ${statusFile})"`,
        `cat ${statFile}`,
      ].join('; '))
      return this.remember({ available: true, divergence: summarizeReport(stdout) })
    } catch (error) {
      return this.remember({ available: false, reason: `Divergence unavailable: ${message(error)}` })
    }
  }

  private async computePatch(): Promise<DivergencePatch> {
    const baseline = this.runtime.baselineState()
    if (!baseline.ready) throw new Error(baseline.reason)
    const pair = baselineGit(this.runtime.paths)
    const cap = MAX_PATCH_BYTES + 1
    const stdout = await this.exec('patch', [
      'set -o pipefail',
      `${pair} add -A -N >/dev/null 2>&1 || true`,
      `${pair} diff --binary --no-renames ${shellQuote(baseline.commit)} | head -c ${String(cap)} | base64 -w0`,
    ].join('; '))
    return {
      commit: baseline.commit,
      ...boundPatchText(decodeReport(stdout, 'patch')),
      checkedAt: new Date().toISOString(),
    }
  }

  private remember(result: DivergenceResult): DivergenceResult {
    this.cached = { at: Date.now(), result }
    return result
  }

  private async exec(label: string, command: string): Promise<string> {
    const sandbox = await this.runtime.getSandbox()
    const result = await withTimeout(execRaw(sandbox, {
      label,
      command,
      cwd: this.runtime.workspaceRoot,
      timeoutSeconds: Math.round(EXEC_TIMEOUT_MS / 1000),
    }), EXEC_TIMEOUT_MS, `The ${label} report`)
    if (result.exitCode === STATUS_FAILED_EXIT) {
      throw new Error(`git could not read the workspace status: ${result.stderr || result.logs || 'no detail'}`)
    }
    if (result.exitCode === DIFF_FAILED_EXIT) {
      throw new Error(`git could not diff against the baseline: ${result.stderr || result.logs || 'no detail'}`)
    }
    if (result.exitCode !== 0 && result.exitCode !== SIGPIPE_EXIT) {
      throw new Error(result.stderr || result.logs || `git exited with code ${String(result.exitCode)}`)
    }
    return result.stdout ?? ''
  }
}

const readers = new WeakMap<BlaxelRuntime, BlaxelDivergence>()

/** One reader per runtime, so the cache survives across requests. */
export function divergenceReader(runtime: BlaxelRuntime): BlaxelDivergence {
  let reader = readers.get(runtime)
  if (reader === undefined) {
    reader = new BlaxelDivergence(runtime)
    readers.set(runtime, reader)
  }
  return reader
}
