import { describe, expect, it, vi } from 'vitest'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { providerDisplayName } from '../src/shared/model-readiness.js'
import { configureMissingModelCredential, inspectModelReadiness } from '../src/web/model-readiness.js'

function harness(options: { configured?: boolean; routable?: boolean; apiKeyEnv?: string; provider?: string; declared?: boolean; record?: CredentialRecord; env?: Record<string, string> } = {}) {
  let configured = options.configured ?? true
  const provider = options.provider ?? 'openai'
  const resolve = vi.fn(async (ref: string) => ref === 'OPENAI_API_KEY' && configured ? { value: 'test-key', source: 'file' } : undefined)
  const readRecord = vi.fn(async () => options.record)
  const environment = createLaunchEnvironmentSnapshot([{ source: 'process', values: options.env ?? {} }])
  const set = vi.fn(async () => {
    configured = true
  })
  return {
    ctx: {
      get: (name: string) => name === 'credentials' ? { resolve, readRecord } : name === 'launchEnvironment' ? environment : undefined,
      sessionController: {
        resolveAgent: async () => ({ agent: { session: { requestHeader: () => ({ config: { provider, model: 'gpt-5.6-luna' } }) } } }),
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
      llm: {
        listProviders: () => (options.routable ?? true) ? [{ id: provider }] : [],
        listConfigurableProviders: () => [{
          provider, displayName: provider, settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider], declared: options.declared ?? false,
        }],
      },
      settingsController: {
        describe: () => ({ namespaces: [{
          ns: 'llm-pi-ai',
          value: { providers: { [provider]: { apiKeyEnv: options.apiKeyEnv ?? 'OPENAI_API_KEY' } } },
        }] }),
      },
      credentialsController: {
        describe: async () => ({ OPENAI_API_KEY: { configured, writable: true } }),
        set,
      },
    },
    set,
    readRecord,
    resolve,
  }
}

describe('model readiness', () => {
  it('presents vendor names when DSH only knows the lowercase provider id', () => {
    expect(providerDisplayName('openai')).toBe('OpenAI')
    expect(providerDisplayName('openai', 'openai')).toBe('OpenAI')
    expect(providerDisplayName('deepseek', 'deepseek')).toBe('DeepSeek')
    expect(providerDisplayName('openai', 'Work OpenAI')).toBe('Work OpenAI')
    expect(providerDisplayName('my-proxy', 'my-proxy')).toBe('my-proxy')
  })

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

  it('refuses an unavailable provider and accepts explicitly declared keyless routes', async () => {
    await expect(inspectModelReadiness(harness({ routable: false }).ctx as never, 'session-1'))
      .resolves.toMatchObject({ kind: 'provider-unavailable', provider: 'openai' })
    const custom = harness({ apiKeyEnv: '', configured: false, provider: 'local-server', declared: true })
    await expect(inspectModelReadiness(custom.ctx as never, 'session-1'))
      .resolves.toMatchObject({ kind: 'ready', provider: 'local-server' })
    expect(custom.readRecord).not.toHaveBeenCalled()
  })

  it('catches implicit OpenAI authentication missing from an empty provider profile', async () => {
    const { ctx } = harness({ apiKeyEnv: '', configured: false })
    await expect(inspectModelReadiness(ctx as never, 'session-1')).resolves.toMatchObject({
      kind: 'credential-missing', credentialRef: 'OPENAI_API_KEY', writable: true,
    })
  })

  it('repairs an implicitly discovered API key through the existing inline form', async () => {
    const { ctx, set } = harness({ apiKeyEnv: '', configured: false })
    await expect(configureMissingModelCredential(ctx as never, 'session-1', 'test-key'))
      .resolves.toMatchObject({ kind: 'ready' })
    expect(set).toHaveBeenCalledWith('OPENAI_API_KEY', 'test-key')
  })

  it.each([
    { record: { kind: 'api-key', key: 'record-test-key' } as CredentialRecord },
    { env: { OPENAI_API_KEY: 'launch-test-key' } as Record<string, string> },
    { provider: 'anthropic', record: { kind: 'grant', payload: { type: 'oauth', access: 'test-access', refresh: 'test-refresh', expires: 0 } } as CredentialRecord },
    { provider: 'amazon-bedrock', env: { AWS_ACCESS_KEY_ID: 'test-access', AWS_SECRET_ACCESS_KEY: 'test-secret' } as Record<string, string> },
  ])('accepts native stored, OAuth, and ambient authentication without returning secrets: %j', async options => {
    const { ctx } = harness({ ...options, apiKeyEnv: '', configured: false })
    const result = await inspectModelReadiness(ctx as never, 'session-1')
    expect(result.kind).toBe('ready')
    expect(Object.keys(result).sort()).toEqual(['kind', 'model', 'provider', 'providerName'])
  })

  it('does not let an OAuth record override an explicit missing API key reference', async () => {
    const { ctx, readRecord } = harness({ configured: false, record: { kind: 'grant', payload: { type: 'oauth' } } })
    await expect(inspectModelReadiness(ctx as never, 'session-1')).resolves.toMatchObject({ kind: 'credential-missing' })
    expect(readRecord).not.toHaveBeenCalled()
  })

  it('fails closed when native credential reads fail without exposing the error payload', async () => {
    const { ctx, resolve } = harness({ apiKeyEnv: '', configured: false })
    resolve.mockRejectedValue(new Error('sensitive-store-detail'))
    const result = await inspectModelReadiness(ctx as never, 'session-1')
    expect(result.kind).toBe('verification-failed')
    expect(JSON.stringify(result)).not.toContain('sensitive-store-detail')
  })

  it('stores only the credential required by the current model and verifies it', async () => {
    const { ctx, set } = harness({ configured: false })
    await expect(configureMissingModelCredential(ctx as never, 'session-1', 'secret-key'))
      .resolves.toMatchObject({ kind: 'ready', provider: 'openai' })
    expect(set).toHaveBeenCalledWith('OPENAI_API_KEY', 'secret-key')
  })
})
