import { describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ reconnect: vi.fn() }))

vi.mock('../src/client/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.js')>()
  return { ...actual, reconnectBlaxelSandbox: api.reconnect }
})

import { SandboxMissingError } from '../src/client/api.js'
import {
  SANDBOX_CHAT_CSS,
  SANDBOX_SURFACE_BACKGROUND,
  SESSION_PANE_SELECTOR,
  continueLocallyConfirmation,
  moveLocalConfirmation,
  recreateConfirmation,
  reconnectNotice,
  reconnectWithConsent,
  sandboxConsoleUrl,
  sandboxPresentation,
} from '../src/client/BlaxelSandboxBanner.js'

describe('sandbox chat identity', () => {
  it('links directly to the exact sandbox in its Blaxel workspace', () => {
    expect(sandboxConsoleUrl('main', 'dsh-0123456789abcdef', 'production')).toBe(
      'https://app.blaxel.ai/main/global-agentic-network/sandbox/dsh-0123456789abcdef',
    )
    expect(sandboxConsoleUrl('dev team', 'sandbox/name', 'development')).toBe(
      'https://app.blaxel.dev/dev%20team/global-agentic-network/sandbox/sandbox%2Fname',
    )
  })

  it('describes the safe move back to local before changing files', () => {
    expect(moveLocalConfirmation(0)).toContain('session will continue in its original worktree')
    expect(moveLocalConfirmation(2)).toContain('2 changed files will be applied')
  })

  it('makes unavailable execution explicitly remote and fail-closed', () => {
    expect(sandboxPresentation('failed')).toEqual({
      title: 'Sandbox unavailable',
      detail: 'This session is not running locally. Reconnect to continue.',
    })
  })

  it('keeps the sandbox treatment scoped to the active chat pane and warns on failure', () => {
    expect(SESSION_PANE_SELECTOR).toBe('[data-slot="conversation"]')
    expect(SANDBOX_SURFACE_BACKGROUND).toBe('var(--dsw-alias-bg-base, #151517)')
    expect(SANDBOX_CHAT_CSS).toContain('[data-blaxel-sandbox-chat="true"]::after')
    expect(SANDBOX_CHAT_CSS).toContain('[data-blaxel-sandbox-state="failed"]::after')
    expect(SANDBOX_CHAT_CSS).toContain('pointer-events: none')
    expect(SANDBOX_CHAT_CSS).toContain('color-mix')
  })
})

describe('reconnecting a sandbox that may be gone', () => {
  it('reconnects silently while the sandbox still exists', async () => {
    api.reconnect.mockReset().mockResolvedValue('reconnected')
    const confirm = vi.fn(() => true)

    await expect(reconnectWithConsent('session-1', confirm)).resolves.toBe('reconnected')
    expect(confirm).not.toHaveBeenCalled()
    expect(api.reconnect).toHaveBeenCalledTimes(1)
  })

  it('never replaces a lost sandbox without consent', async () => {
    api.reconnect.mockReset().mockRejectedValue(new SandboxMissingError())
    const confirm = vi.fn(() => false)

    await expect(reconnectWithConsent('session-1', confirm)).resolves.toBe('cancelled')
    expect(confirm).toHaveBeenCalledWith(recreateConfirmation())
    expect(api.reconnect).toHaveBeenCalledTimes(1)
  })

  it('recreates from the local worktree once the user agrees, and says what was lost', async () => {
    api.reconnect.mockReset().mockRejectedValueOnce(new SandboxMissingError()).mockResolvedValueOnce('recreated')

    await expect(reconnectWithConsent('session-1', () => true)).resolves.toBe('recreated')
    expect(api.reconnect).toHaveBeenLastCalledWith('session-1', { recreate: true })
    expect(reconnectNotice('recreated')).toContain('were not recovered')
    expect(recreateConfirmation()).toContain('cannot be recovered')
    expect(continueLocallyConfirmation()).toContain('permanently lost')
  })

  it('surfaces other reconnect failures unchanged', async () => {
    api.reconnect.mockReset().mockRejectedValue(new Error('Reconnect the main Blaxel workspace'))

    await expect(reconnectWithConsent('session-1', () => true)).rejects.toThrow('Reconnect the main Blaxel workspace')
  })
})
