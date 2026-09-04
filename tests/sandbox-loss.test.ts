import { describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({ get: vi.fn() }))

vi.mock('@blaxel/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@blaxel/core')>()
  return { ...actual, SandboxInstance: class { static get = sdk.get } }
})

import { BlaxelRuntime, SANDBOX_GONE, SANDBOX_PROBE_INTERVAL_MS, sandboxIsGone } from '../src/runtime/service.js'
import { BlaxelSessionRuntime } from '../src/session-runtime/service.js'
import { BlaxelProcessHandle } from '../src/subprocess/process-handle.js'
import { BlaxelSubprocessRuntime } from '../src/subprocess/service.js'

function connectedRuntime(): BlaxelRuntime {
  const runtime = Object.create(BlaxelRuntime.prototype) as BlaxelRuntime
  Object.assign(runtime, {
    lifecycle: 'ready', disposed: false, name: 'dsh-gone',
    ctx: { logger: { warn: vi.fn() } }, ready: Promise.resolve({}),
  })
  return runtime
}

describe('a sandbox that disappears while a session is connected', () => {
  it('recognises the platform answers that mean gone, not slow', () => {
    expect(sandboxIsGone(new Error('Sandbox request failed with status 404: {"action":"Retry"}'))).toBe(true)
    expect(sandboxIsGone({ code: 404, message: 'Sandbox not found' })).toBe(true)
    expect(sandboxIsGone(new Error('Blaxel sandbox is TERMINATED'))).toBe(true)
    expect(sandboxIsGone(new Error('Sandbox request failed with status 503'))).toBe(false)
  })

  it('is noticed by the throttled liveness probe and fails every later call fast', async () => {
    const runtime = connectedRuntime()
    sdk.get.mockResolvedValueOnce({ status: 'DEPLOYED' })
    await runtime.probe(1_000)
    expect(runtime.phase).toBe('ready')

    sdk.get.mockResolvedValueOnce({ status: 'TERMINATED' })
    await runtime.probe(2_000)
    expect(runtime.phase).toBe('ready')
    expect(sdk.get).toHaveBeenCalledTimes(1)

    await runtime.probe(1_000 + SANDBOX_PROBE_INTERVAL_MS)
    expect(runtime.phase).toBe('failed')
    expect(runtime.unavailableReason).toBe(SANDBOX_GONE)
    await expect(runtime.getSandbox()).rejects.toThrow(SANDBOX_GONE)
  })

  it('is noticed when the platform says the sandbox is unknown', async () => {
    const runtime = connectedRuntime()
    sdk.get.mockRejectedValueOnce(Object.assign(new Error('Sandbox not found'), { code: 404 }))
    await runtime.probe(SANDBOX_PROBE_INTERVAL_MS)
    expect(runtime.phase).toBe('failed')
  })

  it('turns a tool call against the lost sandbox into a failed process, never an unhandled rejection', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    const markUnavailable = vi.fn(() => true)
    const runtime = {
      runtimeRoot: '/workspace/.dsh-blaxel',
      unavailableReason: SANDBOX_GONE,
      getSandbox: vi.fn(async () => { throw new Error('Sandbox request failed with status 404') }),
      getSandboxEnvironment: vi.fn(),
      markUnavailable,
    }
    const handle = new BlaxelProcessHandle(runtime as never, {
      argv: ['pwd'], cwd: '/workspace', env: {}, graceMs: 100,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    } as never)
    await expect(handle.done).rejects.toThrow(SANDBOX_GONE)
    // DSH exits on any unhandled rejection, so terminate() after a failed start must stay quiet too.
    handle.terminate()
    await new Promise(resolve => setTimeout(resolve, 25))
    process.off('unhandledRejection', unhandled)
    expect(unhandled).not.toHaveBeenCalled()
    expect(markUnavailable).toHaveBeenCalledOnce()
  })

  it('lets the subprocess runtime forget the failed process without an unhandled rejection', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    const blaxel = {
      runtimeRoot: '/workspace/.dsh-blaxel',
      unavailableReason: SANDBOX_GONE,
      getSandbox: vi.fn(async () => { throw new Error('Sandbox request failed with status 404') }),
      getSandboxEnvironment: vi.fn(),
      markUnavailable: vi.fn(() => true),
      toRemotePath: (path: string) => path,
    }
    const subprocess = Object.create(BlaxelSubprocessRuntime.prototype) as BlaxelSubprocessRuntime
    Object.assign(subprocess, { ctx: { blaxel }, disposing: false, live: new Set() })

    const handle = subprocess.spawn({ argv: ['pwd'], cwd: '/workspace', env: {}, graceMs: 100, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } } as never)
    expect(subprocess.ownedProcesses()).toBe(1)
    await expect(handle.waitForExit()).rejects.toThrow(SANDBOX_GONE)
    await new Promise(resolve => setTimeout(resolve, 25))
    process.off('unhandledRejection', unhandled)
    expect(unhandled).not.toHaveBeenCalled()
    expect(subprocess.ownedProcesses()).toBe(0)
  })

  it('shows up as unavailable in status and lets Reconnect recover from the binding', async () => {
    const sessions = Object.create(BlaxelSessionRuntime.prototype) as BlaxelSessionRuntime
    const release = vi.fn(async () => undefined)
    const probe = vi.fn(async () => undefined)
    const dead = {
      phase: 'failed', name: 'dsh-dead', cwd: '/workspace', workspaceRoot: '/workspace', startedAt: 1,
      unavailableReason: SANDBOX_GONE, probe,
    }
    const binding = { sessionId: 's1', workspace: 'w', environment: 'production' }
    const internal = sessions as unknown as {
      recovery: Promise<void>
      sessions: Map<string, unknown>
      bindings: { list(): unknown[]; get(id: string): unknown }
      launch: { snapshot(): undefined }
      settings: { status(): Promise<{ connection: { workspace: string; environment: string } }> }
      recoveryErrors: Map<string, string>
      missingSandboxes: Set<string>
      recoverPersistedBindings(): Promise<void>
    }
    internal.recovery = Promise.resolve()
    internal.sessions = new Map([['s1', {
      sessionId: 's1', workspace: 'w', environment: 'production', runtime: dead,
      subprocess: { ownedProcesses: () => 0 }, provenance: { cwd: '/repo', repoRoot: '/repo' }, release,
    }]])
    internal.bindings = { list: () => [binding], get: () => binding }
    internal.launch = { snapshot: () => undefined }
    internal.settings = { status: async () => ({ connection: { workspace: 'w', environment: 'production' } }) }
    internal.recoveryErrors = new Map()
    internal.missingSandboxes = new Set(['s1'])
    internal.recoverPersistedBindings = vi.fn(async () => undefined)

    const status = await sessions.status()
    expect(probe).toHaveBeenCalledOnce()
    expect(status.sandboxes).toHaveLength(1)
    expect(status.sandboxes[0]).toMatchObject({ sessionId: 's1', state: 'failed', error: SANDBOX_GONE })

    await expect(sessions.reconnect('s1')).resolves.toBe('missing')
    expect(release).toHaveBeenCalledOnce()
    expect(internal.sessions.has('s1')).toBe(false)
  })
})
