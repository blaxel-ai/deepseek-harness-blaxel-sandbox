/** Path identity for one sandbox: where it works, and how host paths map in. */
import { isAbsolute, posix, relative, sep } from 'node:path'

export interface RuntimePaths {
  /** Remote working directory shared by every mounted capability. */
  cwd: string
  /** Root the selected Git worktree is restored under. */
  workspaceRoot: string
  /** Host worktree root whose absolute paths map into `workspaceRoot`. */
  sourceRoot: string | undefined
  /** Private plugin state; a repository may never seed it. */
  runtimeRoot: string
}

export function mapWorkspacePath(sourceRoot: string | undefined, workspaceRoot: string, path: string): string {
  if (sourceRoot === undefined || !isAbsolute(path)) return path
  const suffix = relative(sourceRoot, path)
  if (suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) return path
  return suffix === '' ? workspaceRoot : posix.join(workspaceRoot, ...suffix.split(sep))
}

function within(root: string, candidate: string): boolean {
  const suffix = posix.relative(root, candidate)
  return suffix !== '..' && !suffix.startsWith('../') && !posix.isAbsolute(suffix)
}

/** Validates the configured roots once, so no later code has to re-check them. */
export function resolveRuntimePaths(config: {
  cwd?: string
  workspaceRoot?: string
  sourceRoot?: string
}): RuntimePaths {
  const cwd = config.cwd ?? '/workspace'
  const workspaceRoot = config.workspaceRoot ?? '/workspace'
  const sourceRoot = config.sourceRoot
  if (!posix.isAbsolute(cwd)) throw new Error(`dsh-blaxel: cwd must be absolute: ${cwd}`)
  if (!posix.isAbsolute(workspaceRoot)) throw new Error(`dsh-blaxel: workspaceRoot must be absolute: ${workspaceRoot}`)
  if (sourceRoot !== undefined && !isAbsolute(sourceRoot)) throw new Error(`dsh-blaxel: sourceRoot must be absolute: ${sourceRoot}`)
  if (!within(workspaceRoot, cwd)) throw new Error(`dsh-blaxel: cwd must be within workspaceRoot: ${cwd}`)
  return { cwd, workspaceRoot, sourceRoot, runtimeRoot: posix.join(workspaceRoot, '.dsh-blaxel') }
}
