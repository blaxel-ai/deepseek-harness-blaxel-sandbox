import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, vi } from 'vitest'
import { RoutingSubprocessRuntime } from '../src/subprocess/router.js'
import { remoteArgv, remoteExecutable } from '../src/subprocess/service.js'

function routingRuntime(ctx: Context, local: SubprocessRuntime): RoutingSubprocessRuntime {
  const runtime = Object.create(RoutingSubprocessRuntime.prototype) as RoutingSubprocessRuntime
  Object.defineProperties(runtime, {
    ctx: { value: ctx },
    local: { value: local },
  })
  return runtime
}

describe('remote subprocess routing', () => {
  it('removes the macOS sandbox wrapper before Linux execution', () => {
    expect(remoteArgv([
      'sandbox-exec',
      '-p',
      '(version 1) (allow default)',
      '--',
      'bash',
      '-c',
      'pwd',
    ])).toEqual(['bash', '-c', 'pwd'])
  })

  it('preserves ordinary subprocess arguments', () => {
    expect(remoteArgv(['bash', '-c', 'pwd'])).toEqual(['bash', '-c', 'pwd'])
  })

  it('uses the sandbox ripgrep instead of the packaged host binary', () => {
    const hostRipgrep = '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg'
    expect(remoteArgv([
      hostRipgrep,
      '--files',
    ])).toEqual(['rg', '--files'])
    expect(remoteExecutable(hostRipgrep)).toBe('rg')
  })

  it('rejects a malformed sandbox wrapper', () => {
    expect(() => remoteArgv(['sandbox-exec', '-p', 'profile'])).toThrow('invalid sandbox-exec wrapper')
  })

  it('ignores a forged environment session id when selecting the backend', async () => {
    const remoteResolve = vi.fn(async () => '/sandbox/bash')
    const localResolve = vi.fn(async () => '/host/bash')
    const remote = { resolveExecutable: remoteResolve } as unknown as SubprocessRuntime
    const local = { resolveExecutable: localResolve } as unknown as SubprocessRuntime
    const ctx = {
      agents: {
        currentInitiator: () => ({ id: 'sandbox-session' }),
        list: () => [{ id: 'sandbox-session' }],
        isOwnedBy: () => false,
      },
      blaxelSessions: {
        get: (sessionId: string | undefined) => sessionId === 'sandbox-session' ? { subprocess: remote } : undefined,
        isSandboxSession: (sessionId: string | undefined) => sessionId === 'sandbox-session',
      },
    } as unknown as Context

    const resolved = await routingRuntime(ctx, local).resolveExecutable('bash', { DSH_SESSION_ID: 'forged-local-session' })

    expect(resolved).toBe('/sandbox/bash')
    expect(remoteResolve).toHaveBeenCalledOnce()
    expect(localResolve).not.toHaveBeenCalled()
  })
})
