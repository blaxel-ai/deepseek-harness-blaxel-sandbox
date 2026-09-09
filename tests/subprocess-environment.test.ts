import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { argvCommand, environmentFor } from '../src/subprocess/environment.js'

afterEach(() => vi.unstubAllEnvs())

describe('sandbox process environment', () => {
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

  it('produces valid Bash with quotes and newlines in user arguments', () => {
    const command = argvCommand(['npm', 'test', "a'b\n$()"], { PATH: '/usr/bin' }, '/workspace', 500)
    expect(() => execFileSync('/bin/bash', ['-n', '-c', command])).not.toThrow()
  })
})
