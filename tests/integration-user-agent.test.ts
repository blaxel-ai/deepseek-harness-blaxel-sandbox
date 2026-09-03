import { describe, expect, it } from 'vitest'
import { INTEGRATION_PRODUCT_TOKEN, installIntegrationUserAgent } from '../src/shared/integration-user-agent.js'

class FakeSettings {
  get headers(): Record<string, string> {
    return {
      'x-blaxel-authorization': 'Bearer test-only',
      'x-blaxel-workspace': 'example',
      'User-Agent': 'blaxel/sdk/typescript/0.3.12 (darwin/arm64) blaxel/4b5045a',
    }
  }
}

describe('integration User-Agent', () => {
  it('appends one product token naming this integration and its version', () => {
    const target = new FakeSettings()
    installIntegrationUserAgent(target)
    expect(INTEGRATION_PRODUCT_TOKEN).toMatch(/^deepseek-harness-blaxel-sandbox\/\d+\.\d+\.\d+/)
    expect(target.headers['User-Agent']).toBe(`blaxel/sdk/typescript/0.3.12 (darwin/arm64) blaxel/4b5045a ${INTEGRATION_PRODUCT_TOKEN}`)
  })

  it('leaves credentials and workspace headers untouched and adds no other header', () => {
    const target = new FakeSettings()
    installIntegrationUserAgent(target)
    const { 'User-Agent': _agent, ...rest } = target.headers
    expect(rest).toEqual({ 'x-blaxel-authorization': 'Bearer test-only', 'x-blaxel-workspace': 'example' })
  })

  it('is idempotent across repeated installs and reads', () => {
    const target = new FakeSettings()
    installIntegrationUserAgent(target)
    installIntegrationUserAgent(target)
    const first = target.headers['User-Agent']
    expect(target.headers['User-Agent']).toBe(first)
    expect(first.split(INTEGRATION_PRODUCT_TOKEN).length).toBe(2)
  })

  it('applies to the real SDK settings singleton', async () => {
    const { settings } = await import('@blaxel/core')
    process.env.BL_API_KEY ??= 'test-only'
    process.env.BL_WORKSPACE ??= 'example-workspace'
    expect(settings.headers['User-Agent']).toMatch(new RegExp(`^blaxel/sdk/typescript/\\S+ \\([^)]+\\) blaxel/\\S+ ${INTEGRATION_PRODUCT_TOKEN.replace('/', '\\/')}$`))
  })
})
