import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  remove: vi.fn(),
}))

vi.mock('@blaxel/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@blaxel/core')>()
  return {
    ...actual,
    SandboxInstance: class {
      static create = sdk.create
      static get = sdk.get
      static delete = sdk.remove
    },
    getConfiguration: vi.fn(async () => ({ error: new Error('offline test') })),
    getWorkspace: vi.fn(async () => ({ error: new Error('offline test') })),
    listSandboxHubDefinitions: vi.fn(async () => ({ error: new Error('offline test') })),
  }
})

import { SandboxBindingStore } from '../src/session-runtime/binding-store.js'
import { BlaxelSessionRuntime, sandboxRecoveryError } from '../src/session-runtime/service.js'

let directory: string
const original = {
  apiKey: process.env.BL_API_KEY,
  workspace: process.env.BL_WORKSPACE,
  environment: process.env.BL_ENV,
  bindingsPath: process.env.DSH_BLAXEL_BINDINGS_PATH,
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-blaxel-recovery-'))
  process.env.BL_API_KEY = 'test-only'
  process.env.BL_WORKSPACE = 'example-workspace'
  process.env.BL_ENV = 'prod'
  process.env.DSH_BLAXEL_BINDINGS_PATH = join(directory, 'bindings.json')
  sdk.create.mockReset()
  sdk.get.mockReset()
  sdk.remove.mockReset()
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
  if (original.apiKey === undefined) delete process.env.BL_API_KEY
  else process.env.BL_API_KEY = original.apiKey
  if (original.workspace === undefined) delete process.env.BL_WORKSPACE
  else process.env.BL_WORKSPACE = original.workspace
  if (original.environment === undefined) delete process.env.BL_ENV
  else process.env.BL_ENV = original.environment
  if (original.bindingsPath === undefined) delete process.env.DSH_BLAXEL_BINDINGS_PATH
  else process.env.DSH_BLAXEL_BINDINGS_PATH = original.bindingsPath
})

describe('sandbox runtime recovery', () => {
  it('turns SDK object failures into a useful missing-sandbox result', () => {
    expect(sandboxRecoveryError({ code: 404, error: 'Sandbox not found' }, 'dsh-private-id')).toEqual({
      missing: true,
      message: 'The sandbox no longer exists.',
    })
  })

  it('refreshes the bound workspace credentials before deleting an active sandbox', async () => {
    const runtime = Object.create(BlaxelSessionRuntime.prototype) as BlaxelSessionRuntime
    const refreshAuthentication = vi.fn(async () => undefined)
    const deleteSandbox = vi.fn(async () => undefined)
    const release = vi.fn(async () => undefined)
    const removeBinding = vi.fn()
    const internal = runtime as unknown as {
      recovery: Promise<void>
      settings: { refreshAuthentication(workspace: string): Promise<void> }
      sessions: Map<string, unknown>
      bindings: { remove(sessionId: string): void }
      recoveryErrors: Map<string, string>
      missingSandboxes: Set<string>
    }
    internal.recovery = Promise.resolve()
    internal.settings = { refreshAuthentication }
    internal.sessions = new Map([['session-active', {
      workspace: 'example-workspace',
      runtime: { deleteSandbox },
      release,
    }]])
    internal.bindings = { remove: removeBinding }
    internal.recoveryErrors = new Map()
    internal.missingSandboxes = new Set()

    await runtime.close('session-active')

    expect(refreshAuthentication).toHaveBeenCalledWith('example-workspace')
    expect(deleteSandbox).toHaveBeenCalledOnce()
    expect(removeBinding).toHaveBeenCalledWith('session-active')
    expect(release).toHaveBeenCalledOnce()
  })

  it('allows credential refresh only for the workspace already bound to persisted sandboxes', () => {
    const runtime = Object.create(BlaxelSessionRuntime.prototype) as BlaxelSessionRuntime
    const internal = runtime as unknown as {
      bindings: { list(): Array<{ workspace: string }> }
      sessions: Map<string, unknown>
      assertCompatibleWorkspace(workspace: unknown): void
      assertNoRunningSandboxes(action: string): void
    }
    internal.bindings = { list: () => [{ workspace: 'example-workspace' }] }
    internal.sessions = new Map()

    expect(() => internal.assertCompatibleWorkspace('example-workspace')).not.toThrow()
    expect(() => internal.assertCompatibleWorkspace('other-workspace')).toThrow('Reconnect the example-workspace workspace')
    expect(() => internal.assertNoRunningSandboxes('switch workspaces')).toThrow('Stop running sandbox sessions')
  })

  it('selects the binding workspace and retries without exposing local providers', async () => {
    const runtime = Object.create(BlaxelSessionRuntime.prototype) as BlaxelSessionRuntime
    const sessions = new Map<string, unknown>()
    const recoverPersistedBindings = vi.fn(async () => { sessions.set('session-restore', {}) })
    const switchWorkspace = vi.fn(async () => undefined)
    const binding = { sessionId: 'session-restore', workspace: 'example-workspace', environment: 'production' }
    const internal = runtime as unknown as {
      recovery: Promise<void>
      sessions: Map<string, unknown>
      bindings: { get(sessionId: string): typeof binding; list(): typeof binding[] }
      settings: { status(): Promise<{ connection: { workspace: string; environment: string } }>; switchWorkspace(workspace: string): Promise<void> }
      recoveryErrors: Map<string, string>
      recoverPersistedBindings(): Promise<void>
    }
    internal.recovery = Promise.resolve()
    internal.sessions = sessions
    internal.bindings = { get: () => binding, list: () => [binding] }
    internal.settings = {
      status: async () => ({ connection: { workspace: 'other-workspace', environment: 'production' } }),
      switchWorkspace,
    }
    internal.recoveryErrors = new Map()
    internal.recoverPersistedBindings = recoverPersistedBindings

    await runtime.reconnect('session-restore')

    expect(switchWorkspace).toHaveBeenCalledWith('example-workspace')
    expect(recoverPersistedBindings).toHaveBeenCalledOnce()
    expect(sessions.has('session-restore')).toBe(true)
  })

  it('reconnects the same session without creating or deleting its sandbox on host disposal', async () => {
    new SandboxBindingStore().save({
      sessionId: 'session-restore',
      title: 'Repository work',
      sandboxName: 'dsh-0123456789abcdef',
      cwd: '/workspace/project',
      workspaceRoot: '/workspace',
      sourceRoot: '/Users/test/project',
      startedAt: Date.now() - 60_000,
      workspace: 'example-workspace',
      environment: 'production',
      provenance: {
        repoRoot: '/Users/test/project', cwd: '/Users/test/project', remoteCwd: '/workspace/project',
        fileCount: 10, skippedSensitive: 0, archiveBytes: 100,
      },
    })
    const deleteSandbox = vi.fn(async () => undefined)
    const exec = vi.fn(async (_request: { command: string }) => ({ exitCode: 0, stdout: 'a'.repeat(40), stderr: '', logs: '' }))
    sdk.get.mockResolvedValue({
      metadata: { name: 'dsh-0123456789abcdef', createdAt: new Date().toISOString() },
      status: 'DEPLOYED',
      spec: { region: 'us-pdx-1', runtime: { image: 'blaxel/node:latest', memory: 4096 } },
      process: { exec },
      delete: deleteSandbox,
    })

    const ctx = new Context()
    const owner = await ctx.plugin(BlaxelSessionRuntime)
    const status = await ctx.blaxelSessions.status()

    expect(status.sandboxes).toHaveLength(1)
    expect(status.sandboxes[0]).toMatchObject({ sessionId: 'session-restore', title: 'Repository work', state: 'ready' })
    expect(ctx.blaxelSessions.isSandboxSession('session-restore')).toBe(true)
    expect(sdk.get).toHaveBeenCalledWith('dsh-0123456789abcdef')
    expect(sdk.create).not.toHaveBeenCalled()
    expect(exec.mock.calls.some(([request]) => String(request.command).includes('refs/dsh/original^{commit}'))).toBe(true)
    expect(exec.mock.calls.some(([request]) => String(request.command).includes('git init'))).toBe(false)

    await owner.dispose()
    expect(deleteSandbox).not.toHaveBeenCalled()
    expect(new SandboxBindingStore().get('session-restore')).toBeDefined()
  })
})

function persistedBinding(): void {
  new SandboxBindingStore().save({
    sessionId: 'session-restore',
    title: 'Repository work',
    sandboxName: 'dsh-0123456789abcdef',
    cwd: '/workspace/project',
    workspaceRoot: '/workspace',
    sourceRoot: '/Users/test/project',
    startedAt: Date.now() - 60_000,
    workspace: 'example-workspace',
    environment: 'production',
    provenance: {
      repoRoot: '/Users/test/project', cwd: '/Users/test/project', remoteCwd: '/workspace/project',
      fileCount: 10, skippedSensitive: 0, archiveBytes: 100,
    },
  })
}

describe('coming back to a sandbox that changed while away', () => {
  it('reports a deleted sandbox as missing and makes reconnect ask instead of recreating', async () => {
    persistedBinding()
    sdk.get.mockRejectedValue({ code: 404, error: 'Sandbox not found' })

    const ctx = new Context()
    await ctx.plugin(BlaxelSessionRuntime)
    const status = await ctx.blaxelSessions.status()

    expect(status.sandboxes[0]).toMatchObject({ sessionId: 'session-restore', state: 'failed', error: 'The sandbox no longer exists.' })
    expect(ctx.blaxelSessions.isSandboxSession('session-restore')).toBe(true)
    await expect(ctx.blaxelSessions.reconnect('session-restore')).resolves.toBe('missing')
    expect(sdk.create).not.toHaveBeenCalled()
  })

  it('lets the user continue locally after the sandbox is gone', async () => {
    persistedBinding()
    sdk.get.mockRejectedValue({ code: 404, error: 'Sandbox not found' })
    sdk.remove.mockRejectedValue({ code: 404, error: 'Sandbox not found' })

    const ctx = new Context()
    await ctx.plugin(BlaxelSessionRuntime)
    await ctx.blaxelSessions.status()
    await ctx.blaxelSessions.close('session-restore')

    expect(sdk.remove).toHaveBeenCalledWith('dsh-0123456789abcdef')
    expect(ctx.blaxelSessions.isSandboxSession('session-restore')).toBe(false)
    expect(new SandboxBindingStore().get('session-restore')).toBeUndefined()
  })

  it('keeps the binding when dropping an unavailable sandbox fails for another reason', async () => {
    persistedBinding()
    sdk.get.mockRejectedValue(new Error('control plane unreachable'))
    sdk.remove.mockRejectedValue(new Error('control plane unreachable'))

    const ctx = new Context()
    await ctx.plugin(BlaxelSessionRuntime)
    await ctx.blaxelSessions.status()

    await expect(ctx.blaxelSessions.close('session-restore')).rejects.toThrow('control plane unreachable')
    await expect(ctx.blaxelSessions.reconnect('session-restore')).rejects.toThrow('control plane unreachable')
    expect(new SandboxBindingStore().get('session-restore')).toBeDefined()
  })

  it('reconnects a sandbox that went to standby while the laptop was closed', async () => {
    persistedBinding()
    sdk.get.mockResolvedValue({
      metadata: { name: 'dsh-0123456789abcdef', createdAt: new Date().toISOString() },
      status: 'STANDBY',
      spec: { region: 'us-pdx-1', runtime: { image: 'blaxel/ts-app:latest', memory: 4096 } },
      process: { exec: vi.fn(async () => ({ exitCode: 0, stdout: 'a'.repeat(40), stderr: '', logs: '' })) },
      delete: vi.fn(),
    })

    const ctx = new Context()
    await ctx.plugin(BlaxelSessionRuntime)
    const status = await ctx.blaxelSessions.status()

    expect(status.sandboxes[0]).toMatchObject({ sessionId: 'session-restore', state: 'ready' })
  })

  it('restores the previous binding when a replacement sandbox cannot start', async () => {
    const runtime = Object.create(BlaxelSessionRuntime.prototype) as BlaxelSessionRuntime
    const previous = { sessionId: 'session-restore', title: 'Repository work', workspace: 'example-workspace', provenance: { cwd: '/Users/test/project' } }
    const store = new Map([[previous.sessionId, previous]])
    const internal = runtime as unknown as {
      recovery: Promise<void>
      sessions: Map<string, unknown>
      missingSandboxes: Set<string>
      bindings: { get(id: string): unknown; remove(id: string): void; save(binding: unknown): void }
      prepare(cwd: string, kind: string): Promise<unknown>
    }
    internal.recovery = Promise.resolve()
    internal.sessions = new Map()
    internal.missingSandboxes = new Set([previous.sessionId])
    internal.bindings = {
      get: id => store.get(id),
      remove: id => { store.delete(id) },
      save: binding => { store.set((binding as typeof previous).sessionId, binding as typeof previous) },
    }
    internal.prepare = vi.fn(async () => { throw new Error('The current workspace directory no longer exists') })

    await expect(runtime.recreateMissing('session-restore')).rejects.toThrow('no longer exists')
    expect(store.get('session-restore')).toBe(previous)
    expect(internal.missingSandboxes.has('session-restore')).toBe(true)
  })

  it('refuses to move changes home while sandbox tools are still running', async () => {
    const runtime = Object.create(BlaxelSessionRuntime.prototype) as BlaxelSessionRuntime
    const internal = runtime as unknown as { recovery: Promise<void>; sessions: Map<string, unknown> }
    internal.recovery = Promise.resolve()
    internal.sessions = new Map([['session-active', { subprocess: { ownedProcesses: () => 1 } }]])

    await expect(runtime.moveChangesLocal('session-active')).rejects.toThrow('Wait for sandbox tool processes to finish')
  })
})
