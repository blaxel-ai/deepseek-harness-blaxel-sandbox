import { afterEach, describe, expect, it, vi } from 'vitest'
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

  it('waits portably for a new process session and forwards termination', () => {
    const command = argvCommand(['npm', 'test'], { PATH: '/usr/bin' }, '/workspace')

    expect(command).toContain("trap 'test -n \"$child\" && kill -TERM -\"$child\"")
    expect(command).toContain("setsid env -i 'PATH=/usr/bin' 'npm' 'test' </dev/null &")
    expect(command).toContain('child=$!; wait "$child"')
    expect(command).not.toContain('setsid -w')
  })
})
