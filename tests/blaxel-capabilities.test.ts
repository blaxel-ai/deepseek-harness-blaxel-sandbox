import { describe, expect, it } from 'vitest'
import { safeCapabilityCommandError } from '../src/blaxel-capabilities.js'

describe('Blaxel capability command errors', () => {
  it('redacts the MCP proxy token from an execFile error message', () => {
    const token = 'secret-proxy-token'
    const error = safeCapabilityCommandError(
      new Error(`Command failed: node mcpc --proxy-bearer-token ${token}`),
      [token],
    )

    expect(error.message).toContain('--proxy-bearer-token [redacted]')
    expect(error.message).not.toContain(token)
  })
})
