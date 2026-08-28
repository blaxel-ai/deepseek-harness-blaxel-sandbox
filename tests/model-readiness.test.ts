import { describe, expect, it, vi } from 'vitest'
import { configureMissingModelCredential, inspectModelReadiness } from '../src/web/model-readiness.js'

function ok<T>(value: T): Promise<{ result: { ok: true; value: T } }> {
  return Promise.resolve({ result: { ok: true, value } })
}

function harness(options: { configured?: boolean; routable?: boolean; apiKeyEnv?: string } = {}) {
  let configured = options.configured ?? true
  const set = vi.fn(async () => {
    configured = true
    return await ok({})
  })
  return {
    ctx: {
      apiProxy: {
        sessions: {
          models: () => ok({ current: { provider: 'openai', model: 'gpt-5.6-luna' }, routable: options.routable ?? true }),
        },
        llm: {
          providers: () => ok({ providers: [{
            provider: 'openai', displayName: 'OpenAI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], active: true,
          }] }),
        },
        settings: {
          describe: () => ok({ namespaces: [{
            ns: 'llm-pi-ai',
            value: { providers: { openai: options.apiKeyEnv === undefined ? { apiKeyEnv: 'OPENAI_API_KEY' } : { apiKeyEnv: options.apiKeyEnv } } },
          }] }),
        },
        credentials: {
          describe: () => ok({ credentials: { OPENAI_API_KEY: { configured, writable: true } } }),
          set,
        },
      },
    },
    set,
  }
}

describe('model readiness', () => {
  it('reports the selected model ready without returning credential values', async () => {
    const { ctx } = harness()
    await expect(inspectModelReadiness(ctx as never, 'session-1')).resolves.toEqual({
      kind: 'ready', provider: 'openai', providerName: 'OpenAI', model: 'gpt-5.6-luna',
    })
  })

  it('identifies the missing resolved credential before sandbox provisioning', async () => {
    const { ctx } = harness({ configured: false })
    await expect(inspectModelReadiness(ctx as never, 'session-1')).resolves.toEqual({
      kind: 'credential-missing',
      provider: 'openai',
      providerName: 'OpenAI',
      model: 'gpt-5.6-luna',
      credentialRef: 'OPENAI_API_KEY',
      writable: true,
    })
  })

  it('refuses an unavailable provider and accepts routes that declare no credential', async () => {
    await expect(inspectModelReadiness(harness({ routable: false }).ctx as never, 'session-1'))
      .resolves.toMatchObject({ kind: 'provider-unavailable', provider: 'openai' })
    await expect(inspectModelReadiness(harness({ apiKeyEnv: '' }).ctx as never, 'session-1'))
      .resolves.toMatchObject({ kind: 'ready', provider: 'openai' })
  })

  it('stores only the credential required by the current model and verifies it', async () => {
    const { ctx, set } = harness({ configured: false })
    await expect(configureMissingModelCredential(ctx as never, 'session-1', 'secret-key'))
      .resolves.toMatchObject({ kind: 'ready', provider: 'openai' })
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      payload: { ref: 'OPENAI_API_KEY', value: 'secret-key' },
    }))
  })
})
