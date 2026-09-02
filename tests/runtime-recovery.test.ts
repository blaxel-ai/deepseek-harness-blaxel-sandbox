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
import { BlaxelSessionRuntime } from '../src/session-runtime/service.js'

let directory: string
const original = {
  apiKey: process.env.BL_API_KEY,
  workspace: process.env.BL_WORKSPACE,
  bindingsPath: process.env.DSH_BLAXEL_BINDINGS_PATH,
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-blaxel-recovery-'))
  process.env.BL_API_KEY = 'test-only'
  process.env.BL_WORKSPACE = 'example-workspace'
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
  if (original.bindingsPath === undefined) delete process.env.DSH_BLAXEL_BINDINGS_PATH
  else process.env.DSH_BLAXEL_BINDINGS_PATH = original.bindingsPath
})

describe('sandbox runtime recovery', () => {
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
