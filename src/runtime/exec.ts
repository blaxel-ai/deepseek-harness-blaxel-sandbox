/** The one way this package runs a bounded command inside its sandbox. */
import { randomUUID } from 'node:crypto'
import type { SandboxInstance } from '@blaxel/core'
import { shellQuote } from '../shared/shell.js'

export type ExecResult = Awaited<ReturnType<SandboxInstance['process']['exec']>>

export interface ExecRequest {
  /** Short label; a unique suffix is added so concurrent runs never collide. */
  label: string
  command: string
  cwd: string
  timeoutSeconds?: number
}

/** Whatever the sandbox said about a failure, in one line, never empty. */
export function execFailure(result: ExecResult): string {
  return result.stderr || result.logs || `exit code ${String(result.exitCode)}`
}

export async function execRaw(sandbox: SandboxInstance, request: ExecRequest): Promise<ExecResult> {
  return await sandbox.process.exec({
    name: `dsh-blaxel-${request.label}-${randomUUID()}`,
    command: `bash -o pipefail -c ${shellQuote(request.command)}`,
    workingDir: request.cwd,
    ...(request.timeoutSeconds === undefined ? {} : { timeout: request.timeoutSeconds }),
    waitForCompletion: true,
  })
}

/** Runs a command and returns its stdout, throwing the sandbox's own reason. */
export async function execChecked(sandbox: SandboxInstance, request: ExecRequest): Promise<string> {
  const result = await execRaw(sandbox, request)
  if (result.exitCode !== 0) throw new Error(execFailure(result))
  return result.stdout ?? ''
}
