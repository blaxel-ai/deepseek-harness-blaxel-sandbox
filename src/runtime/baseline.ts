/**
 * The divergence baseline: a private Git directory holding the tree exactly as
 * it was restored. The workspace points at it through `.git`, so ordinary Git
 * commands work without copying the host repository's private Git metadata.
 */
import type { SandboxInstance } from '@blaxel/core'
import { shellQuote } from '../shared/shell.js'
import { execFailure, execRaw } from './exec.js'
import type { RuntimePaths } from './paths.js'

/** Baseline state for divergence reports, or why there is none. */
export type BlaxelBaseline = { ready: true; commit: string } | { ready: false; reason: string }

const TIMEOUT_MS = 150_000
const COMMIT_TIMEOUT_SECONDS = 120
const RESTORE_TIMEOUT_SECONDS = 20
const COMMIT_SHA = /^[0-9a-f]{40}$/
const BASELINE_REF = 'refs/dsh/original'

export const BASELINE_PENDING: BlaxelBaseline = {
  ready: false,
  reason: 'The divergence baseline is still being created',
}

/** Keeps a baseline failure short, single-line, and safe to show in the UI. */
export function baselineReason(detail: string, action: 'create' | 'restore' = 'create'): string {
  const summary = detail.replaceAll(/\s+/g, ' ').trim().slice(0, 240)
  return `Could not ${action} the divergence baseline${summary === '' ? '' : `: ${summary}`}`
}

/** The git invocation that pairs the private repository with the workspace. */
export function baselineGit(paths: Pick<RuntimePaths, 'runtimeRoot' | 'workspaceRoot'>): string {
  const gitDir = `${paths.runtimeRoot}/baseline.git`
  return `git -c safe.directory='*' --git-dir=${shellQuote(gitDir)} --work-tree=${shellQuote(paths.workspaceRoot)}`
}

function attachWorkspace(paths: Pick<RuntimePaths, 'runtimeRoot' | 'workspaceRoot'>): string[] {
  const gitDir = `${paths.runtimeRoot}/baseline.git`
  return [
    `git --git-dir=${shellQuote(gitDir)} config core.bare false`,
    `git --git-dir=${shellQuote(gitDir)} config core.worktree ${shellQuote(paths.workspaceRoot)}`,
    `printf 'gitdir: %s\\n' ${shellQuote(gitDir)} > ${shellQuote(`${paths.workspaceRoot}/.git`)}`,
  ]
}

async function commitBaseline(sandbox: SandboxInstance, paths: RuntimePaths): Promise<BlaxelBaseline> {
  const gitDir = `${paths.runtimeRoot}/baseline.git`
  const pair = baselineGit(paths)
  const command = [
    `git init --quiet --bare ${shellQuote(gitDir)}`,
    ...attachWorkspace(paths),
    `mkdir -p ${shellQuote(`${gitDir}/info`)}`,
    `printf '%s\\n' '/.dsh-blaxel/' '.dsh-*.tmp/' > ${shellQuote(`${gitDir}/info/exclude`)}`,
    `${pair} add -A`,
    `${pair} -c user.name=dsh-blaxel -c user.email=dsh-blaxel@localhost commit --quiet --allow-empty -m baseline`,
    `${pair} update-ref ${shellQuote(BASELINE_REF)} HEAD`,
    `${pair} rev-parse --verify ${shellQuote(`${BASELINE_REF}^{commit}`)}`,
  ].join(' && ')
  try {
    const result = await execRaw(sandbox, {
      label: 'divergence-baseline',
      command,
      cwd: paths.workspaceRoot,
      timeoutSeconds: COMMIT_TIMEOUT_SECONDS,
    })
    const commit = result.stdout?.trim() ?? ''
    if (result.exitCode !== 0 || !COMMIT_SHA.test(commit)) {
      return { ready: false, reason: baselineReason(execFailure(result)) }
    }
    return { ready: true, commit }
  } catch (error) {
    return { ready: false, reason: baselineReason(error instanceof Error ? error.message : String(error)) }
  }
}

/** Reads the immutable original commit without touching the recovered workspace. */
async function readBaseline(sandbox: SandboxInstance, paths: RuntimePaths): Promise<BlaxelBaseline> {
  const gitDir = `${paths.runtimeRoot}/baseline.git`
  const pair = baselineGit(paths)
  try {
    const result = await execRaw(sandbox, {
      label: 'divergence-baseline-restore',
      command: [
        `test -d ${shellQuote(gitDir)}`,
        `! test -L ${shellQuote(gitDir)}`,
        ...attachWorkspace(paths),
        // Older bindings predate the immutable ref. Migrate their existing
        // commit without staging, committing, or changing the worktree.
        `commit="$(${pair} rev-parse --verify ${shellQuote(`${BASELINE_REF}^{commit}`)} 2>/dev/null || ${pair} rev-parse --verify 'HEAD^{commit}')"`,
        `${pair} update-ref ${shellQuote(BASELINE_REF)} "$commit"`,
        `printf '%s\\n' "$commit"`,
      ].join(' && '),
      cwd: paths.workspaceRoot,
      timeoutSeconds: RESTORE_TIMEOUT_SECONDS,
    })
    const commit = result.stdout?.trim() ?? ''
    if (result.exitCode !== 0 || !COMMIT_SHA.test(commit)) {
      return { ready: false, reason: baselineReason(execFailure(result), 'restore') }
    }
    return { ready: true, commit }
  } catch (error) {
    return { ready: false, reason: baselineReason(error instanceof Error ? error.message : String(error), 'restore') }
  }
}

/** Never rejects and never outlives its deadline. */
async function withinDeadline(work: Promise<BlaxelBaseline>, action: 'create' | 'restore'): Promise<BlaxelBaseline> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<BlaxelBaseline>((resolve) => {
    timer = setTimeout(
      () => resolve({ ready: false, reason: baselineReason('the baseline operation did not finish in time', action) }),
      TIMEOUT_MS,
    )
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Creates the one original baseline before tools are allowed to edit. */
export async function createBaseline(sandbox: SandboxInstance, paths: RuntimePaths): Promise<BlaxelBaseline> {
  return await withinDeadline(commitBaseline(sandbox, paths), 'create')
}

/** Restores the original baseline after a host restart; it never creates one. */
export async function restoreBaseline(sandbox: SandboxInstance, paths: RuntimePaths): Promise<BlaxelBaseline> {
  return await withinDeadline(readBaseline(sandbox, paths), 'restore')
}
