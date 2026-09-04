import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { DivergencePatch } from './divergence.js'
import { inspectGitWorkspace } from './workspace-snapshot.js'

const execFileAsync = promisify(execFile)
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024
const MODE_HEADER = /^(?:new file mode|deleted file mode|old mode|new mode)[ \t]+([0-7]+)/
const INDEX_HEADER = /^index[ \t]+[0-9a-f]+\.\.[0-9a-f]+[ \t]+([0-7]+)/i
const TRANSFER_HEADER = /^(?:copy|rename)[ \t]+(?:from|to)(?:[ \t]|$)/
const SYMLINK_MODE = 0o120000
const TYPE_MASK = 0o170000

/** A guest patch must never introduce or rewrite a host-followed symlink. */
export function assertSafeSandboxPatch(text: string): void {
  for (const line of text.split('\n')) {
    if (TRANSFER_HEADER.test(line)) {
      throw new Error('Sandbox changes include a copy or rename, so nothing was applied locally')
    }
    const encoded = MODE_HEADER.exec(line)?.[1] ?? INDEX_HEADER.exec(line)?.[1]
    if (encoded !== undefined && (Number.parseInt(encoded, 8) & TYPE_MASK) === SYMLINK_MODE) {
      throw new Error('Sandbox changes include a symbolic link, so nothing was applied locally')
    }
  }
}

function parsePatchTargets(numstat: string): string[] {
  const records = numstat.split('\0')
  const targets: string[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    const firstTab = record.indexOf('\t')
    const secondTab = firstTab === -1 ? -1 : record.indexOf('\t', firstTab + 1)
    if (secondTab === -1) continue
    const path = record.slice(secondTab + 1)
    if (path !== '') {
      targets.push(path)
      continue
    }
    if (records[index + 1] !== undefined && records[index + 1] !== '') targets.push(records[index += 1])
    if (records[index + 1] !== undefined && records[index + 1] !== '') targets.push(records[index += 1])
  }
  return targets
}

async function assertSafeHostTargets(repoRoot: string, patchPath: string): Promise<void> {
  const { stdout } = await execFileAsync('git', [
    '-C', repoRoot,
    'apply',
    '--numstat',
    '-z',
    '--binary',
    patchPath,
  ], { encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT_BYTES })
  for (const target of parsePatchTargets(stdout)) {
    const absolute = resolve(repoRoot, target)
    const local = relative(repoRoot, absolute)
    if (local === '' || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) {
      throw new Error('Sandbox changes target a path outside the original worktree')
    }
    let current = repoRoot
    for (const part of local.split(sep)) {
      current = join(current, part)
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          throw new Error('Sandbox changes target a symbolic link, so nothing was applied locally')
        }
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') break
        throw error
      }
    }
  }
}

async function patchAlreadyApplied(repoRoot: string, patchPath: string): Promise<boolean> {
  try {
    await execFileAsync('git', [
      '-C', repoRoot,
      'apply',
      '--reverse',
      '--check',
      '--binary',
      '--whitespace=nowarn',
      patchPath,
    ], { encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT_BYTES })
    return true
  } catch {
    return false
  }
}

async function gitApply(repoRoot: string, patchPath: string, check: boolean): Promise<void> {
  try {
    await execFileAsync('git', [
      '-C', repoRoot,
      'apply',
      ...(check ? ['--check'] : []),
      '--binary',
      '--whitespace=nowarn',
      patchPath,
    ], { encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT_BYTES })
  } catch (error) {
    const detail = error instanceof Error && 'stderr' in error && typeof error.stderr === 'string'
      ? error.stderr.replaceAll(/\s+/g, ' ').trim().slice(0, 400)
      : ''
    throw new Error(check
      ? `Local files changed since this sandbox started, so nothing was applied${detail === '' ? '' : `: ${detail}`}`
      : `The sandbox patch could not be applied locally${detail === '' ? '' : `: ${detail}`}`)
  }
}

/**
 * Keeps a conflicting patch inside the repository's private Git directory so the
 * work is never lost when the automatic transfer has to fail closed. The Git
 * directory is resolved through git itself so linked worktrees are handled.
 */
async function preserveConflictingPatch(repoRoot: string, patch: DivergencePatch): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'rev-parse', '--absolute-git-dir'], {
    encoding: 'utf8',
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  })
  const directory = join(stdout.trim(), 'dsh-blaxel')
  await mkdir(directory, { mode: 0o700, recursive: true })
  const stamp = patch.checkedAt.replaceAll(/[^0-9A-Za-z]/g, '').slice(0, 14)
  const path = join(directory, `sandbox-${stamp}.patch`)
  await writeFile(path, patch.text, { encoding: 'utf8', mode: 0o600 })
  return path
}

/** Conflict-checks and applies one bounded sandbox patch to its original worktree. */
export async function applySandboxPatch(repoRoot: string, patch: DivergencePatch): Promise<void> {
  if (patch.truncated) throw new Error('Sandbox changes exceed the automatic 1 MiB patch limit')
  if (patch.text === '') return
  assertSafeSandboxPatch(patch.text)
  const workspace = await inspectGitWorkspace(repoRoot)
  const directory = await mkdtemp(join(tmpdir(), 'dsh-blaxel-sync-'))
  const patchPath = join(directory, 'sandbox.patch')
  try {
    await writeFile(patchPath, patch.text, { encoding: 'utf8', mode: 0o600 })
    await assertSafeHostTargets(workspace.repoRoot, patchPath)
    try {
      await gitApply(workspace.repoRoot, patchPath, true)
    } catch (error) {
      if (await patchAlreadyApplied(workspace.repoRoot, patchPath)) return
      const kept = await preserveConflictingPatch(workspace.repoRoot, patch)
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}. The sandbox changes were saved to ${kept}; `
        + `the sandbox is still running. Resolve the local conflict and retry, or merge the saved patch with \`git apply --3way\`.`,
      )
    }
    await gitApply(workspace.repoRoot, patchPath, false)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}
