import { describe, expect, it } from 'vitest'
import { SANDBOX_CHAT_CSS, sandboxConsoleUrl } from '../src/client/BlaxelSandboxBanner.js'

describe('sandbox chat identity', () => {
  it('links directly to the exact sandbox in its Blaxel workspace', () => {
    expect(sandboxConsoleUrl('main', 'dsh-0123456789abcdef', 'production')).toBe(
      'https://app.blaxel.ai/main/global-agentic-network/sandbox/dsh-0123456789abcdef',
    )
    expect(sandboxConsoleUrl('dev team', 'sandbox/name', 'development')).toBe(
      'https://app.blaxel.dev/dev%20team/global-agentic-network/sandbox/sandbox%2Fname',
    )
  })

  it('keeps the sandbox treatment scoped to the active chat pane', () => {
    expect(SANDBOX_CHAT_CSS).toContain('[data-blaxel-sandbox-chat="true"]::after')
    expect(SANDBOX_CHAT_CSS).toContain('pointer-events: none')
    expect(SANDBOX_CHAT_CSS).toContain('color-mix')
  })
})
