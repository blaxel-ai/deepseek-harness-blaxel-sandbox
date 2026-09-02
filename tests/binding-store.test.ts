import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultBindingStorePath, SandboxBindingStore, type PersistedSandboxBinding } from '../src/session-runtime/binding-store.js'

const directories: string[] = []

function temporaryPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-blaxel-bindings-'))
  directories.push(directory)
  return join(directory, 'bindings.json')
}

function binding(sessionId = 'session-1'): PersistedSandboxBinding {
  return {
    sessionId,
    title: 'Repository work',
    sandboxName: 'dsh-0123456789abcdef',
    cwd: '/workspace/project',
    workspaceRoot: '/workspace',
    sourceRoot: '/Users/test/project',
    startedAt: 1_725_000_000_000,
    workspace: 'example-workspace',
    environment: 'production',
    provenance: {
      repoRoot: '/Users/test/project',
      cwd: '/Users/test/project',
      remoteCwd: '/workspace/project',
      fileCount: 12,
      skippedSensitive: 1,
      archiveBytes: 2048,
      branch: 'main',
      commit: '0123456789abcdef',
    },
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('sandbox binding persistence', () => {
  it('isolates bindings inside an explicit DSH home', () => {
    expect(defaultBindingStorePath({
      DSH_HOME: '/tmp/dsh-home',
      XDG_CONFIG_HOME: '/tmp/shared-config',
    })).toBe('/tmp/dsh-home/blaxel-sandbox-bindings.json')
    expect(defaultBindingStorePath({
      DSH_BLAXEL_BINDINGS_PATH: '/tmp/explicit-bindings.json',
      DSH_HOME: '/tmp/dsh-home',
    })).toBe('/tmp/explicit-bindings.json')
  })

  it('atomically survives process reconstruction and explicit removal', () => {
    const path = temporaryPath()
    const first = new SandboxBindingStore(path)
    first.save(binding())

    expect(new SandboxBindingStore(path).list()).toEqual([binding()])
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ version: 1 })

    first.remove('session-1')
    expect(new SandboxBindingStore(path).list()).toEqual([])
  })

  it('fails closed when persisted identity is malformed', () => {
    const path = temporaryPath()
    writeFileSync(path, JSON.stringify({ version: 1, bindings: [{ ...binding(), sandboxName: '../other-workspace' }] }))
    expect(() => new SandboxBindingStore(path)).toThrow('invalid entry')
  })

  it('fails closed when a persisted session title is malformed', () => {
    const path = temporaryPath()
    writeFileSync(path, JSON.stringify({ version: 1, bindings: [{ ...binding(), title: 'bad\0title' }] }))
    expect(() => new SandboxBindingStore(path)).toThrow('invalid entry')
  })
})
