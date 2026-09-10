import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => {
  let cached: { workspace: string } | null = null
  return {
    fail: false,
    setConfig: vi.fn(),
    get credentials(): { workspace: string } {
      if (this.fail) throw new Error('Credential load failed')
      return cached ??= { workspace: process.env.BL_WORKSPACE ?? 'other-terminal' }
    },
    set credentials(value: { workspace: string } | null) { cached = value },
  }
})
vi.mock('@blaxel/core', () => ({
  settings: sdk,
  getConfiguration: vi.fn().mockResolvedValue({ error: 'offline' }),
  getWorkspace: vi.fn().mockResolvedValue({ error: 'offline' }),
  listSandboxHubDefinitions: vi.fn().mockResolvedValue({ error: 'offline' }),
  listSandboxes: vi.fn().mockResolvedValue({ error: 'offline' }),
}))

import { BlaxelSettingsManager } from '../src/blaxel-settings.js'

let directory: string
let manager: BlaxelSettingsManager
let configuration: string
let savedEnvironment: NodeJS.ProcessEnv
const authNames = ['BL_WORKSPACE', 'BL_API_KEY', 'BL_CLIENT_CREDENTIALS', 'BL_CLOUD', 'BL_GENERATION', 'BL_ENV']

beforeEach(async () => {
  savedEnvironment = Object.fromEntries(authNames.map(name => [name, process.env[name]]))
  for (const name of authNames) delete process.env[name]
  directory = await mkdtemp(join(tmpdir(), 'dsh-workspace-auth-'))
  configuration = join(directory, 'config.yaml')
  await writeFile(configuration, 'context:\n  workspace: other-terminal\nworkspaces:\n  - name: session-team\n    credentials:\n      apiKey: test-only\n')
  manager = new BlaxelSettingsManager({ cliConfig: configuration, defaults: join(directory, 'defaults.json') })
  sdk.fail = false
  sdk.credentials = null
})

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const name of authNames) {
    if (savedEnvironment[name] === undefined) delete process.env[name]
    else process.env[name] = savedEnvironment[name]
  }
  await rm(directory, { recursive: true, force: true })
})

it('keeps the session workspace and credentials when another terminal changes CLI context', async () => {
  const originalConfiguration = await readFile(configuration, 'utf8')
  await manager.refreshAuthentication('session-team')
  expect(sdk.credentials.workspace).toBe('session-team')
  expect(process.env.BL_WORKSPACE).toBeUndefined()
  expect((await manager.status()).connection).toMatchObject({ workspace: 'session-team', authenticated: true, managedByEnvironment: false })
  await manager.refreshAuthentication()
  expect(sdk.credentials.workspace).toBe('session-team')
  expect(await readFile(configuration, 'utf8')).toBe(originalConfiguration)
})

it('preserves an explicitly environment-managed workspace instead of selecting another tenant', async () => {
  process.env.BL_WORKSPACE = 'managed-team'
  process.env.BL_API_KEY = 'managed-test-key'
  await manager.refreshAuthentication('session-team')
  expect((await manager.status()).connection).toMatchObject({ workspace: 'managed-team', managedByEnvironment: true })
  expect(sdk.credentials.workspace).toBe('managed-team')
})

it('follows the new CLI context after the last binding releases its workspace', async () => {
  await manager.refreshAuthentication('session-team')
  await writeFile(configuration, 'context:\n  workspace: next-team\nworkspaces:\n  - name: next-team\n    credentials:\n      apiKey: test-only\n')
  manager.releaseWorkspace()
  await manager.refreshAuthentication()
  expect(sdk.credentials.workspace).toBe('next-team')
  expect((await manager.status()).connection.workspace).toBe('next-team')
})

it('reconnects a pinned development workspace against the development OAuth endpoint', async () => {
  await writeFile(configuration, 'context:\n  workspace: other-terminal\nworkspaces:\n  - name: session-team\n    env: dev\n    credentials:\n      apiKey: test-only\n')
  await manager.refreshAuthentication('session-team')
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ device_code: 'test-only', verification_uri_complete: 'https://app.blaxel.dev/activate', interval: 3, expires_in: 180 })))
  vi.stubGlobal('fetch', fetch)
  await manager.beginBrowserLogin()
  expect(fetch).toHaveBeenCalledWith('https://api.blaxel.dev/v0/login/device', expect.any(Object))
})

it('restores the process workspace if SDK credential loading fails', async () => {
  sdk.fail = true
  await expect(manager.refreshAuthentication('session-team')).rejects.toThrow('Credential load failed')
  expect(process.env.BL_WORKSPACE).toBeUndefined()
})
