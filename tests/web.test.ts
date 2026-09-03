import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import type { BlaxelHttpRequest, BlaxelHttpResponse, BlaxelWebRoute } from '../src/web/context.js'
import { apply } from '../src/web.js'

function request(action: 'open' | 'move', body: object): BlaxelHttpRequest {
  const encoded = Buffer.from(JSON.stringify(body))
  const req = {
    method: 'POST',
    url: `/blaxel/api/${action}`,
    headers: { 'x-dsh-blaxel-action': action },
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
    apply(ctx as never)
    if (route === undefined) throw new Error('Blaxel Web route was not registered')

    const target = response()
    await route.handler(request('open', { cwd: process.cwd(), sessionId: 'local-session', title: 'Repository work' }), target.res)
    expect(target.status()).toBe(200)
    expect(target.body()).toEqual({ ok: true, sessionId: 'local-session' })
    expect(createSession).toHaveBeenCalledWith({ workspaceId: 'workspace-repo', sessionId: 'local-session' })
    expect(bind).toHaveBeenCalledWith(prepared, 'local-session', 'Repository work')
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
    apply(ctx as never)
    if (route === undefined) throw new Error('Blaxel Web route was not registered')

    const target = response()
    await route.handler(request('move', { cwd: process.cwd(), sessionId: 'local-session' }), target.res)
    expect(target.status()).toBe(200)
    expect(target.body()).toEqual({ ok: true, sessionId: 'local-session' })
    expect(bind).toHaveBeenCalledWith(prepared, 'local-session', undefined)
  })

  it('discards the sandbox if the session starts running before the handoff', async () => {
    let route: BlaxelWebRoute | undefined
    const prepared = { marker: true }
    const bind = vi.fn()
    const discard = vi.fn()
    const list = vi.fn()
      .mockResolvedValueOnce({ items: [{ sessionId: 'local-session', running: false }] })
      .mockResolvedValueOnce({ items: [{ sessionId: 'local-session', running: true }] })
    const modelApi = readyModelApi()
    const ctx = {
      effect: (setup: () => unknown) => setup(),
      webServer: { register: (registered: BlaxelWebRoute) => { route = registered; return () => undefined } },
      ...modelApi,
      sessionController: { ...modelApi.sessionController, create: vi.fn(), list },
      workspaceController: { create: vi.fn() },
      blaxelSessions: {
        prepare: vi.fn(async () => prepared),
        bind,
        discard,
        close: vi.fn(),
        status: vi.fn(async () => ({ sandboxes: [] })),
      },
      logger: { warn: () => undefined },
    }
    apply(ctx as never)
    if (route === undefined) throw new Error('Blaxel Web route was not registered')

    const target = response()
    await route.handler(request('move', { cwd: process.cwd(), sessionId: 'local-session' }), target.res)
    expect(target.status()).toBe(422)
    expect(target.body()).toEqual({ ok: false, error: 'The session started running while its sandbox was being prepared' })
    expect(bind).not.toHaveBeenCalled()
    expect(discard).toHaveBeenCalledWith(prepared)
  })

  it('does not provision a sandbox while the selected model credential is missing', async () => {
    let route: BlaxelWebRoute | undefined
    const modelApi = readyModelApi()
    modelApi.credentialsController.describe.mockResolvedValue({ OPENAI_API_KEY: { configured: false, writable: true } })
    const prepare = vi.fn()
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
        prepare,
        bind: vi.fn(),
        discard: vi.fn(),
        close: vi.fn(),
        status: vi.fn(async () => ({ sandboxes: [] })),
      },
    }
    apply(ctx as never)
    if (route === undefined) throw new Error('Blaxel Web route was not registered')
    const target = response()
    await route.handler(request('move', { cwd: process.cwd(), sessionId: 'local-session' }), target.res)
    expect(target.status()).toBe(422)
    expect(target.body()).toEqual({ ok: false, error: 'Add your OpenAI API key before using this sandbox.' })
    expect(prepare).not.toHaveBeenCalled()
  })
})
