import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import type { BlaxelHttpRequest, BlaxelHttpResponse, BlaxelWebRoute } from '../src/web/context.js'
import { apply, inject } from '../src/web.js'
import { requireReadyModel } from '../src/web/model-readiness.js'

function request(action: 'open' | 'move' | 'reconnect' | 'sync-local', body: object): BlaxelHttpRequest {
  const encoded = Buffer.from(JSON.stringify(body))
  const req = {
    method: 'POST',
    url: `/blaxel/api/${action}`,
    headers: { host: '127.0.0.1:3080', 'x-dsh-blaxel-action': action },
    on(event: string, listener: (value?: Buffer) => void) {
      if (event === 'data') listener(encoded)
      if (event === 'end') listener()
      return req
    },
  }
  return req as unknown as BlaxelHttpRequest
}

function response(): { res: BlaxelHttpResponse; status: () => number | undefined; body: () => unknown } {
  let code: number | undefined
  let payload: unknown
  return {
    res: {
      writeHead: status => { code = status },
      end: body => { payload = body === undefined ? undefined : JSON.parse(String(body)) },
    },
    status: () => code,
    body: () => payload,
  }
}

function readyModelApi() {
  return {
    sessionController: {
      resolveAgent: vi.fn(async () => ({ agent: { session: { requestHeader: () => ({ config: { provider: 'openai', model: 'gpt-5.6-luna' } }) } } })),
    },
    llm: {
      listProviders: vi.fn(() => [{ id: 'openai' }]),
      listConfigurableProviders: vi.fn(() => [{
        provider: 'openai', displayName: 'OpenAI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'],
      }]),
    },
    agentDefaultModel: { currentSelection: vi.fn(() => ({ provider: 'openai', model: 'gpt-5.6-luna' })) },
    settingsController: {
      describe: vi.fn(() => ({ namespaces: [{
        ns: 'llm-pi-ai', value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
      }] })),
    },
    credentialsController: {
      describe: vi.fn(async () => ({ OPENAI_API_KEY: { configured: true, writable: true } })),
      set: vi.fn(async () => undefined),
    },
  }
}

describe('Blaxel Web routing', () => {
  it('injects the session projection used to resolve the active model', () => {
    expect(inject).toContain('sessionProjections')
  })

  it('adopts and binds the current native session inside its workspace', async () => {
    let route: BlaxelWebRoute | undefined
    const prepared = { marker: true }
    const bind = vi.fn()
        const createSession = vi.fn(async () => ({ sessionId: 'local-session' }))
    const modelApi = readyModelApi()
    const ctx = {
      effect: (setup: () => unknown) => setup(),
      webServer: { register: (registered: BlaxelWebRoute) => { route = registered; return () => undefined } },
      ...modelApi,
      sessionController: {
        ...modelApi.sessionController,
        create: createSession,
        list: async () => ({ items: [] }),
      },
      workspaceController: {
        create: async () => ({ workspace: { workspaceId: 'workspace-repo' } }),
      },
      blaxelSessions: {
        prepare: async () => prepared,
        bind,
        discard: async () => undefined,
        close: async () => undefined,
        status: async () => ({ sandboxes: [] }),
      },
      logger: { warn: () => undefined },
    }
    const move = vi.fn(async (sessionId: string) => { await requireReadyModel(ctx as never, sessionId); return { sessionId, url: 'https://private-session.example/' } })
    apply({ connection: { requestRejection: () => undefined }, blaxelCloud: { move }, ...ctx } as never)
    if (route === undefined) throw new Error('Blaxel Web route was not registered')

    const target = response()
    await route.handler(request('open', { cwd: process.cwd(), sessionId: 'local-session', title: 'Repository work' }), target.res)
    expect(target.status()).toBe(200)
    expect(target.body()).toEqual({ ok: true, sessionId: 'local-session', url: 'https://private-session.example/' })
    expect(createSession).toHaveBeenCalledWith({ workspaceId: 'workspace-repo', sessionId: 'local-session' })
    expect(move).toHaveBeenCalledWith('local-session', process.cwd(), 'http://127.0.0.1:3080', 'Repository work')
  })

  it('moves an idle session by binding its existing id without forking', async () => {
    let route: BlaxelWebRoute | undefined
    const prepared = { marker: true }
    const bind = vi.fn()
    const modelApi = readyModelApi()
    const ctx = {
      effect: (setup: () => unknown) => setup(),
      webServer: { register: (registered: BlaxelWebRoute) => { route = registered; return () => undefined } },
      ...modelApi,
      sessionController: {
        ...modelApi.sessionController,
        create: vi.fn(),
        list: vi.fn(async () => ({ items: [{ sessionId: 'local-session', running: false }] })),
      },
      workspaceController: { create: vi.fn() },
      blaxelSessions: {
        prepare: vi.fn(async () => prepared),
        bind,
        discard: vi.fn(),
        close: vi.fn(),
        status: vi.fn(async () => ({ sandboxes: [] })),
      },
      logger: { warn: () => undefined },
    }
    const move = vi.fn(async (sessionId: string) => { await requireReadyModel(ctx as never, sessionId); return { sessionId, url: 'https://private-session.example/' } })
    apply({ connection: { requestRejection: () => undefined }, blaxelCloud: { move }, ...ctx } as never)
    if (route === undefined) throw new Error('Blaxel Web route was not registered')

    const target = response()
    await route.handler(request('move', { cwd: process.cwd(), sessionId: 'local-session' }), target.res)
    expect(target.status()).toBe(200)
    expect(target.body()).toEqual({ ok: true, sessionId: 'local-session', url: 'https://private-session.example/' })
    expect(move).toHaveBeenCalledWith('local-session', process.cwd(), 'http://127.0.0.1:3080', undefined)
  })

  it('reconnects an unavailable sandbox binding in place', async () => {
    let route: BlaxelWebRoute | undefined
    const reconnect = vi.fn(async () => undefined)
    const ctx = {
      effect: (setup: () => unknown) => setup(),
      webServer: { register: (registered: BlaxelWebRoute) => { route = registered; return () => undefined } },
      blaxelSessions: { reconnect, binding: () => undefined },
    }
    const move = vi.fn(async (sessionId: string) => { await requireReadyModel(ctx as never, sessionId); return { sessionId, url: 'https://private-session.example/' } })
    apply({ connection: { requestRejection: () => undefined }, blaxelCloud: { move }, ...ctx } as never)
    if (route === undefined) throw new Error('Blaxel Web route was not registered')

    const target = response()
    await route.handler(request('reconnect', { sessionId: 'remote-session' }), target.res)
    expect(target.status()).toBe(200)
    expect(target.body()).toEqual({ ok: true, outcome: 'reconnected' })
    expect(reconnect).toHaveBeenCalledWith('remote-session')
  })

  it('creates a replacement when reconnect confirms the sandbox is gone', async () => {
    let route: BlaxelWebRoute | undefined
    const recreateMissing = vi.fn(async () => undefined)
    const modelApi = readyModelApi()
    const ctx = {
      effect: (setup: () => unknown) => setup(),
      webServer: { register: (registered: BlaxelWebRoute) => { route = registered; return () => undefined } },
      ...modelApi,
      sessionController: {
        ...modelApi.sessionController,
        list: vi.fn(async () => ({ items: [{ sessionId: 'remote-session', running: false }] })),
      },
      blaxelSessions: {
        binding: () => undefined,
        reconnect: vi.fn(async () => 'missing'),
        recreateMissing,
      },
    }
    const move = vi.fn(async (sessionId: string) => { await requireReadyModel(ctx as never, sessionId); return { sessionId, url: 'https://private-session.example/' } })
    apply({ connection: { requestRejection: () => undefined }, blaxelCloud: { move }, ...ctx } as never)
    if (route === undefined) throw new Error('Blaxel Web route was not registered')

    const asked = response()
    await route.handler(request('reconnect', { sessionId: 'remote-session' }), asked.res)
    expect(asked.status()).toBe(409)
    expect(asked.body()).toEqual({ ok: false, error: 'sandbox-missing' })
    expect(recreateMissing).not.toHaveBeenCalled()

    const consented = response()
    await route.handler(request('reconnect', { sessionId: 'remote-session', recreate: true }), consented.res)
    expect(consented.status()).toBe(200)
    expect(consented.body()).toEqual({ ok: true, outcome: 'recreated' })
    expect(recreateMissing).toHaveBeenCalledWith('remote-session')
  })

  it('refuses to move changes home while the session is still running a turn', async () => {
    let route: BlaxelWebRoute | undefined
    const moveChangesLocal = vi.fn()
    const ctx = {
      effect: (setup: () => unknown) => setup(),
      webServer: { register: (registered: BlaxelWebRoute) => { route = registered; return () => undefined } },
      sessionController: { list: vi.fn(async () => ({ items: [{ sessionId: 'remote-session', running: true }] })) },
      blaxelSessions: { moveChangesLocal, binding: () => undefined },
    }
    const move = vi.fn(async (sessionId: string) => { await requireReadyModel(ctx as never, sessionId); return { sessionId, url: 'https://private-session.example/' } })
    apply({ connection: { requestRejection: () => undefined }, blaxelCloud: { move }, ...ctx } as never)
    if (route === undefined) throw new Error('Blaxel Web route was not registered')

    const target = response()
    await route.handler(request('sync-local', { sessionId: 'remote-session' }), target.res)
    expect(target.status()).toBe(422)
    expect(target.body()).toEqual({ ok: false, error: 'Wait for the current turn to finish before moving changes locally' })
    expect(moveChangesLocal).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated requests before starting a transfer', async () => {
    let route: BlaxelWebRoute | undefined
    const move = vi.fn()
    apply({
      connection: { requestRejection: () => 401 },
      effect: (setup: () => unknown) => setup(),
      webServer: { register: (registered: BlaxelWebRoute) => { route = registered; return () => undefined } },
      blaxelCloud: { move },
    } as never)
    const target = response()
    await route!.handler(request('move', { cwd: process.cwd(), sessionId: 'local-session' }), target.res)
    expect(target.status()).toBe(401)
    expect(move).not.toHaveBeenCalled()
  })

  it.each(['explicit', 'implicit'])('does not provision a sandbox while the selected model %s credential is missing', async mode => {
    let route: BlaxelWebRoute | undefined
    const modelApi = readyModelApi()
    modelApi.credentialsController.describe.mockResolvedValue({ OPENAI_API_KEY: { configured: false, writable: true } })
    if (mode === 'implicit') modelApi.settingsController.describe.mockReturnValue({ namespaces: [{
      ns: 'llm-pi-ai', value: { providers: { openai: { apiKeyEnv: '' } } },
    }] })
    const prepare = vi.fn()
    const ctx = {
      get: (name: string) => name === 'launchEnvironment' ? createLaunchEnvironmentSnapshot([]) : undefined,
      effect: (setup: () => unknown) => setup(),
      webServer: { register: (registered: BlaxelWebRoute) => { route = registered; return () => undefined } },
      ...modelApi,
      sessionController: {
        ...modelApi.sessionController,
        create: vi.fn(),
        list: vi.fn(async () => ({ items: [{ sessionId: 'local-session', running: false }] })),
      },
      workspaceController: { create: vi.fn() },
      blaxelSessions: {
        prepare,
        bind: vi.fn(),
        discard: vi.fn(),
        close: vi.fn(),
        status: vi.fn(async () => ({ sandboxes: [] })),
      },
    }
    const move = vi.fn(async (sessionId: string) => { await requireReadyModel(ctx as never, sessionId); return { sessionId, url: 'https://private-session.example/' } })
    apply({ connection: { requestRejection: () => undefined }, blaxelCloud: { move }, ...ctx } as never)
    if (route === undefined) throw new Error('Blaxel Web route was not registered')
    const target = response()
    await route.handler(request('move', { cwd: process.cwd(), sessionId: 'local-session' }), target.res)
    expect(target.status()).toBe(422)
    expect(target.body()).toEqual({ ok: false, error: 'Add your OpenAI API key before using this sandbox.' })
    expect(prepare).not.toHaveBeenCalled()
  })
})
