import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BlaxelSettingsManager, validateSandboxDefaults, validateWorkspace } from '../src/blaxel-settings.js'

const authNames = ['BL_API_KEY', 'BL_CLIENT_CREDENTIALS', 'BL_WORKSPACE', 'BL_CLOUD', 'BL_GENERATION', 'BL_ENV'] as const
let directory = ''
let savedEnvironment: Record<string, string | undefined>

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-blaxel-settings-'))
  savedEnvironment = Object.fromEntries(authNames.map(name => [name, process.env[name]]))
  for (const name of authNames) delete process.env[name]
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const name of authNames) {
    const value = savedEnvironment[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await rm(directory, { recursive: true, force: true })
})

describe('Blaxel settings', () => {
  it('reports CLI profiles without returning credential material', async () => {
    const cliConfig = join(directory, '.blaxel', 'config.yaml')
    await mkdir(join(directory, '.blaxel'))
    await writeFile(cliConfig, `context:\n  workspace: team-one\nworkspaces:\n  - name: team-one\n    credentials:\n      apiKey: never-return-this\n  - name: logged-out\n`)
    const manager = new BlaxelSettingsManager({ cliConfig, defaults: join(directory, 'defaults.json') })
    const status = await manager.status()

    expect(status.connection).toMatchObject({ authenticated: true, source: 'cli', workspace: 'team-one', profiles: ['team-one'] })
    expect(JSON.stringify(status)).not.toContain('never-return-this')
  })

  it('persists validated sandbox defaults in a private file', async () => {
    const defaultsPath = join(directory, 'config', 'defaults.json')
    const manager = new BlaxelSettingsManager({ cliConfig: join(directory, 'missing.yaml'), defaults: defaultsPath })
    vi.spyOn(manager, 'status').mockResolvedValue({
      connection: { authenticated: true, source: 'cli', workspace: 'team-one', environment: 'production', profiles: ['team-one'], managedByEnvironment: false },
      defaults: { image: 'blaxel/node:latest', memory: 4096 },
      choices: {
        images: [{ value: 'blaxel/node:latest', label: 'Node' }],
        memory: [4096, 8192],
        regions: [{ value: '', label: 'Automatic' }, { value: 'us-was-1', label: 'N. Virginia' }],
        idleDeletion: [{ value: '', label: 'No maximum' }, { value: '24h', label: '24 hours' }],
        verified: true,
        maxMemory: 8192,
      },
    })
    const defaults = await manager.saveDefaults({ image: 'blaxel/node:latest', memory: 8192, region: 'us-was-1', ttl: '24h' })

    expect(defaults).toEqual({ image: 'blaxel/node:latest', memory: 8192, region: 'us-was-1', ttl: '24h' })
    expect(JSON.parse(await readFile(defaultsPath, 'utf8'))).toEqual(defaults)
  })

  it('rejects invalid workspace names and unsafe resource defaults', () => {
    expect(() => validateWorkspace('../other')).toThrow('workspace name')
    expect(() => validateSandboxDefaults({ image: 'bad image', memory: 4096 })).toThrow('sandbox image')
    expect(() => validateSandboxDefaults({ image: 'blaxel/node:latest', memory: 12 })).toThrow('Memory')
    expect(() => validateSandboxDefaults({ image: 'blaxel/node:latest', memory: 4096, ttl: 'forever' })).toThrow('Idle deletion')
  })

  it('refreshes a device login through the CLI before reloading SDK credentials', async () => {
    const cliConfig = join(directory, '.blaxel', 'config.yaml')
    await mkdir(join(directory, '.blaxel'))
    await writeFile(cliConfig, `context:\n  workspace: team-one\nworkspaces:\n  - name: team-one\n    credentials:\n      access_token: old-access\n      refresh_token: old-refresh\n      device_code: device-code\n`)
    const manager = new BlaxelSettingsManager({ cliConfig, defaults: join(directory, 'defaults.json') })
    const internal = manager as unknown as { runCli: (args: string[]) => Promise<void>; resetSdk: (workspace: string) => Promise<void> }
    const runCli = vi.spyOn(internal, 'runCli').mockResolvedValue()
    const resetSdk = vi.spyOn(internal, 'resetSdk').mockResolvedValue()

    await manager.refreshAuthentication('team-one')

    expect(runCli).toHaveBeenCalledWith(['token', '--workspace', 'team-one', '--skip-version-warning'])
    expect(resetSdk).toHaveBeenCalledWith('team-one')
  })

  it('keeps a working connection when proactive CLI refresh is broken', async () => {
    const cliConfig = join(directory, '.blaxel', 'config.yaml')
    await mkdir(join(directory, '.blaxel'))
    await writeFile(cliConfig, `context:\n  workspace: team-one\nworkspaces:\n  - name: team-one\n    credentials:\n      access_token: working-access\n      refresh_token: old-refresh\n      device_code: device-code\n`)
    const manager = new BlaxelSettingsManager({ cliConfig, defaults: join(directory, 'defaults.json') })
    const internal = manager as unknown as {
      runCli: (args: string[]) => Promise<void>
      resetSdk: (workspace: string) => Promise<void>
      connectionStillWorks: () => Promise<boolean>
    }
    vi.spyOn(internal, 'runCli').mockRejectedValue(new Error('failed to refresh token'))
    const resetSdk = vi.spyOn(internal, 'resetSdk').mockResolvedValue()
    vi.spyOn(internal, 'connectionStillWorks').mockResolvedValue(true)

    await expect(manager.refreshAuthentication('team-one')).resolves.toBeUndefined()
    expect(resetSdk).toHaveBeenCalledWith('team-one')
  })

  it('completes browser OAuth without sending tokens to the browser', async () => {
    const cliConfig = join(directory, '.blaxel', 'config.yaml')
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/login/device')) return new Response(JSON.stringify({ device_code: 'device-secret', verification_uri_complete: 'https://signin.blaxel.ai/device', expires_in: 180, interval: 1 }), { status: 200 })
      if (url.endsWith('/oauth/token')) return new Response(JSON.stringify({ access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600 }), { status: 200 })
      if (url.endsWith('/workspaces')) return new Response(JSON.stringify([{ name: 'team-one', displayName: 'Team One', id: 'ws-1' }]), { status: 200 })
      return new Response(JSON.stringify({ error: 'not mocked' }), { status: 503 })
    })
    const manager = new BlaxelSettingsManager({ cliConfig, defaults: join(directory, 'defaults.json') })

    const started = await manager.beginBrowserLogin()
    const authorized = await manager.pollBrowserLogin(started.id)
    expect(JSON.stringify({ started, authorized })).not.toContain('secret')
    expect(authorized).toMatchObject({ state: 'choose-workspace', workspaces: [{ value: 'team-one', label: 'Team One' }] })

    const completed = await manager.completeBrowserLogin(started.id, 'team-one')
    expect(completed.connection).toMatchObject({ authenticated: true, workspace: 'team-one' })
    const saved = await readFile(cliConfig, 'utf8')
    expect(saved).toContain('access-secret')
    expect(saved).toContain('refresh-secret')
  })
})
