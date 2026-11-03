import { describe, expect, it } from 'vitest'
import { piAiProvider } from '../src/web/pi-ai-providers.js'

describe('piAiProvider', () => {
  it.each(['azure-openai-responses', 'azure'])('resolves the Azure provider by its %s id', id => {
    const provider = piAiProvider(id)
    expect(provider?.id).toBe(id)
    expect(provider?.auth?.apiKey).toBeDefined()
  })

  it('returns undefined for an unknown provider', () => {
    expect(piAiProvider('no-such-provider')).toBeUndefined()
  })
})
