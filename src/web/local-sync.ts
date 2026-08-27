import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { DivergencePatch } from './divergence.js'
import { inspectGitWorkspace } from './workspace-snapshot.js'

const execFileAsync = promisify(execFile)
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024
const MODE_HEADER = /^(?:new file mode|deleted file mode|old mode|new mode)[ \t]+([0-7]+)/
const INDEX_HEADER = /^index[ \t]+[0-9a-f]+\.\.[0-9a-f]+[ \t]+([0-7]+)/i
const SYMLINK_MODE = 0o120000
const TYPE_MASK = 0o170000

/** A guest patch must never introduce or rewrite a host-followed symlink. */
export function assertSafeSandboxPatch(text: string): void {
  for (const line of text.split('\n')) {
    const encoded = MODE_HEADER.exec(line)?.[1] ?? INDEX_HEADER.exec(line)?.[1]
    if (encoded !== undefined && (Number.parseInt(encoded, 8) & TYPE_MASK) === SYMLINK_MODE) {
      throw new Error('Sandbox changes include a symbolic link, so nothing was applied locally')
    }
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
    await gitApply(workspace.repoRoot, patchPath, true)
    await gitApply(workspace.repoRoot, patchPath, false)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}
