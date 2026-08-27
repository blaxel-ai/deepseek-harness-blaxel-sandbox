/** Reads the sandbox's own ambient environment, byte-exactly and once. */
import type { SandboxInstance } from '@blaxel/core'
import { decodeBase64Text } from '../shared/transport.js'
import { execFailure, execRaw } from './exec.js'

export async function readSandboxEnvironment(
  sandbox: SandboxInstance,
  cwd: string,
): Promise<ReadonlyMap<string, string>> {
  const result = await execRaw(sandbox, {
    label: 'environment',
    command: 'env -0 | base64 -w0',
    cwd,
  })
  if (result.exitCode !== 0) {
    throw new Error(`dsh-blaxel: could not read sandbox environment: ${execFailure(result)}`)
  }
  const environment = new Map<string, string>()
  for (const entry of decodeBase64Text(result.stdout ?? '', 'sandbox environment').split('\0')) {
    const separator = entry.indexOf('=')
    if (separator > 0) environment.set(entry.slice(0, separator), entry.slice(separator + 1))
  }
  return environment
}
