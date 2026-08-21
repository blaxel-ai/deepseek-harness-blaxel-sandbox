import { afterEach, describe, expect, it, vi } from 'vitest'
import { mapWorkspacePath, shellQuote } from '../src/index.js'
import { environmentFor } from '../src/subprocess-service.js'

afterEach(() => vi.unstubAllEnvs())

describe('dsh-blaxel', () => {
  it('quotes POSIX arguments without interpolation', () => {
    expect(shellQuote("a'b; $(touch /tmp/nope)\n")).toBe("'a'\"'\"'b; $(touch /tmp/nope)\n'")
  })

  it('maps source-worktree paths into the remote workspace only', () => {
    expect(mapWorkspacePath('/Users/test/repo', '/workspace', '/Users/test/repo')).toBe('/workspace')
    expect(mapWorkspacePath('/Users/test/repo', '/workspace', '/Users/test/repo/packages/app')).toBe('/workspace/packages/app')
    expect(mapWorkspacePath('/Users/test/repo', '/workspace', '/Users/test/other')).toBe('/Users/test/other')
    expect(mapWorkspacePath('/Users/test/repo', '/workspace', 'relative/file.ts')).toBe('relative/file.ts')
  })

  it('uses the sandbox environment without forwarding inherited host values', () => {
    vi.stubEnv('PATH', '/host/bin')
    vi.stubEnv('CMUX_SOCKET_CAPABILITY', 'host-capability')
    vi.stubEnv('BL_API_KEY', 'host-key')
    const result = environmentFor(new Map([
      ['HOME', '/root'],
      ['PATH', '/usr/local/bin:/usr/bin'],
      ['REMOTE_ONLY', 'drop-ambient-metadata'],
      ['REMOTE_TOKEN', 'remove-me'],
    ]), {
      PATH: '/host/bin',
      CMUX_SOCKET_CAPABILITY: 'host-capability',
      BL_API_KEY: 'host-key',
      DSH_SESSION_ID: 'session-id',
      EXPLICIT_TOKEN: 'drop-explicit-secret',
      EXPLICIT: 'kept',
    })

    expect(result).toEqual({
      HOME: '/root',
      PATH: '/usr/local/bin:/usr/bin',
      EXPLICIT: 'kept',
    })
  })
})
