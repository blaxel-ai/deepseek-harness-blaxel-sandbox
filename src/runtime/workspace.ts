/** Sandbox-side setup: the restored worktree and the private runtime root. */
import { readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import type { SandboxInstance } from '@blaxel/core'
import { shellQuote } from '../shared/shell.js'
import { execFailure, execRaw } from './exec.js'
import type { RuntimePaths } from './paths.js'

const REQUIRED_RUNTIME_TOOLS = ['bash', 'base64', 'env', 'git', 'mkfifo', 'ps', 'rg', 'setsid', 'tar']

/**
 * Installs the small native toolset lean application images commonly omit,
 * then fails early if the selected image cannot host a coding agent.
 */
export function runtimeToolPreparationCommand(): string {
  const required = REQUIRED_RUNTIME_TOOLS.join(' ')
  return [
    'if ! command -v rg >/dev/null 2>&1 || ! command -v ps >/dev/null 2>&1; then',
    'if command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ripgrep procps;',
    'elif command -v apk >/dev/null 2>&1; then apk add --no-cache ripgrep procps >/dev/null;',
    'elif command -v dnf >/dev/null 2>&1; then dnf install -y -q ripgrep procps-ng;',
    'else echo "selected sandbox image cannot install required runtime tools" >&2; exit 127; fi;',
    'fi;',
    `for tool in ${required}; do command -v "$tool" >/dev/null 2>&1 || { echo "selected sandbox image is missing required tool: $tool" >&2; exit 127; }; done`,
  ].join(' ')
}

export async function prepareRuntimeTools(sandbox: SandboxInstance, paths: RuntimePaths): Promise<void> {
  const result = await execRaw(sandbox, {
    label: 'prepare-runtime-tools',
    command: runtimeToolPreparationCommand(),
    cwd: paths.cwd,
  })
  if (result.exitCode !== 0) throw new Error(`dsh-blaxel: sandbox image is not ready for DSH tools: ${execFailure(result)}`)
}

/** Unpacks the host archive, refusing to let it seed the plugin's own state. */
export async function restoreWorkspace(
  sandbox: SandboxInstance,
  paths: RuntimePaths,
  archiveHostPath: string,
): Promise<void> {
  const remoteArchive = posix.join(paths.runtimeRoot, 'workspace.tar.gz')
  await sandbox.fs.writeBinary(remoteArchive, await readFile(archiveHostPath))
  const result = await execRaw(sandbox, {
    label: 'restore-workspace',
    command: [
      `tar --exclude='.dsh-blaxel' --exclude='.dsh-blaxel/**' -xzf ${shellQuote(remoteArchive)} -C ${shellQuote(paths.workspaceRoot)}`,
      `rm -f -- ${shellQuote(remoteArchive)}`,
    ].join(' && '),
    cwd: paths.workspaceRoot,
  })
  if (result.exitCode !== 0) throw new Error(`dsh-blaxel: could not restore Git worktree: ${execFailure(result)}`)
}

/** The runtime root must be a real, private directory before adapters activate. */
export async function protectRuntimeRoot(sandbox: SandboxInstance, paths: RuntimePaths): Promise<void> {
  const quoted = shellQuote(paths.runtimeRoot)
  const result = await execRaw(sandbox, {
    label: 'protect-runtime',
    command: `test -d ${quoted} && ! test -L ${quoted} && chmod 700 -- ${quoted}`,
    cwd: paths.cwd,
  })
  if (result.exitCode !== 0) {
    throw new Error(`dsh-blaxel: runtime root must be a real private directory: ${paths.runtimeRoot}`)
  }
}
