import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { getConfiguration, getWorkspace, listSandboxHubDefinitions, listSandboxes, settings as sdkSettings } from '@blaxel/core'
import './shared/integration-user-agent.js'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

const runFile = promisify(execFile)
const DEFAULT_IMAGE = 'blaxel/ts-app:latest'
const DEFAULT_MEMORY = 4096
const WORKSPACE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const MEMORY_CHOICES = [128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072]
const TTL_CHOICES = [
  { value: '', label: 'Platform default' },
  { value: '30m', label: '30 minutes' },
  { value: '1h', label: '1 hour' },
  { value: '4h', label: '4 hours' },
  { value: '8h', label: '8 hours' },
  { value: '24h', label: '24 hours' },
  { value: '3d', label: '3 days' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
]

export interface SandboxDefaults {
  image: string
  memory: number
  region?: string
  ttl?: string
}

export type AuthSource = 'api-key-environment' | 'client-credentials-environment' | 'blaxel-host' | 'cli' | 'none'

export interface BlaxelConnection {
  authenticated: boolean
  source: AuthSource
  workspace?: string
  environment: 'production' | 'development'
  profiles: string[]
  managedByEnvironment: boolean
}

export interface BlaxelSettingsStatus {
  connection: BlaxelConnection
  defaults: SandboxDefaults
  choices: BlaxelSettingsChoices
}

export interface BlaxelChoice {
  value: string
  label: string
  detail?: string
  recommendedMemory?: number
  available?: boolean
}

export interface BlaxelSettingsChoices {
  images: BlaxelChoice[]
  memory: number[]
  regions: BlaxelChoice[]
  idleDeletion: BlaxelChoice[]
  verified: boolean
  workspace?: string
  plan?: string
  tier?: string
  maxMemory?: number
  maxTtlDays?: number
  unavailable?: string
}

interface AccountQuota {
  resourceType?: unknown
  value?: unknown
}

interface AccountSummary {
  spec?: {
    subscription?: { plan?: unknown; tier?: unknown }
  }
}

export interface BrowserLoginState {
  id: string
  state: 'waiting' | 'choose-workspace'
  authorizationUrl?: string
  workspaces?: BlaxelChoice[]
}

interface CliWorkspace {
  name?: unknown
  id?: unknown
  env?: unknown
  credentials?: unknown
}

interface CliConfiguration {
  context?: { workspace?: unknown }
  workspaces?: unknown
  tracking?: unknown
}

interface OAuthTokens {
  accessToken: string
  refreshToken: string
  expiresIn: number
  deviceCode: string
}

interface PendingBrowserLogin {
  id: string
  authorizationUrl: string
  deviceCode: string
  expiresAt: number
  nextPollAt: number
  intervalMs: number
  environment: 'production' | 'development'
  tokens?: OAuthTokens
  workspaces?: BlaxelChoice[]
}

export interface BlaxelSettingsPaths {
  cliConfig: string
  defaults: string
}

export function defaultSettingsPaths(): BlaxelSettingsPaths {
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  return {
    cliConfig: join(homedir(), '.blaxel', 'config.yaml'),
    defaults: join(configHome, 'deepseek-harness', 'blaxel-sandbox.json'),
  }
}

function optionalText(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.length > maxLength || value.includes('\0')) throw new Error(`A valid ${field} is required`)
  const result = value.trim()
  return result === '' ? undefined : result
}

export function validateWorkspace(value: unknown): string {
  const workspace = optionalText(value, 'workspace', 63)
  if (workspace === undefined || !WORKSPACE_NAME.test(workspace)) throw new Error('Use a valid Blaxel workspace name')
  return workspace
}

export function validateSandboxDefaults(value: unknown): SandboxDefaults {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Sandbox defaults must be an object')
  const input = value as Record<string, unknown>
  const image = optionalText(input.image, 'sandbox image', 256)
  if (image === undefined || /\s/.test(image)) throw new Error('Use a valid sandbox image')
  if (typeof input.memory !== 'number' || !Number.isInteger(input.memory) || input.memory < 512 || input.memory > 131072) {
    throw new Error('Memory must be a whole number from 512 to 131072 MB')
  }
  const region = optionalText(input.region, 'region', 64)
  const ttl = optionalText(input.ttl, 'idle deletion time', 32)
  if (ttl !== undefined && !/^\d+(?:m|h|d|w)$/.test(ttl)) throw new Error('Idle deletion time must look like 30m, 24h, 7d, or 1w')
  return { image, memory: input.memory, ...(region === undefined ? {} : { region }), ...(ttl === undefined ? {} : { ttl }) }
}

function environmentDefaults(): SandboxDefaults {
  const memory = Number(process.env.DSH_BLAXEL_MEMORY ?? DEFAULT_MEMORY)
  return validateSandboxDefaults({
    image: process.env.DSH_BLAXEL_IMAGE ?? DEFAULT_IMAGE,
    memory: Number.isInteger(memory) ? memory : DEFAULT_MEMORY,
    region: process.env.DSH_BLAXEL_REGION,
    ttl: process.env.DSH_BLAXEL_TTL,
  })
}

function durationDays(value: string): number {
  const match = /^(\d+)(m|h|d|w)$/.exec(value)
  if (match === null) return Number.POSITIVE_INFINITY
  const amount = Number(match[1])
  if (match[2] === 'm') return amount / 1_440
  if (match[2] === 'h') return amount / 24
  if (match[2] === 'w') return amount * 7
  return amount
}

async function readCliConfiguration(path: string): Promise<{ current?: string; workspaces: CliWorkspace[] }> {
  try {
    const parsed = parseYaml(await readFile(path, 'utf8')) as CliConfiguration | undefined
    const current = typeof parsed?.context?.workspace === 'string' ? parsed.context.workspace : undefined
    const workspaces = Array.isArray(parsed?.workspaces) ? parsed.workspaces.filter((item): item is CliWorkspace => typeof item === 'object' && item !== null) : []
    return { ...(current === undefined ? {} : { current }), workspaces }
  } catch {
    return { workspaces: [] }
  }
}

async function readCliDocument(path: string): Promise<CliConfiguration> {
  try {
    const parsed = parseYaml(await readFile(path, 'utf8')) as CliConfiguration | undefined
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {}
    throw new Error('The Blaxel CLI configuration could not be read')
  }
}

function authEnvironmentSource(): AuthSource | undefined {
  if (process.env.BL_API_KEY?.trim()) return 'api-key-environment'
  if (process.env.BL_CLIENT_CREDENTIALS?.trim()) return 'client-credentials-environment'
  if (process.env.BL_CLOUD === 'true' || process.env.BL_GENERATION !== undefined) return 'blaxel-host'
  return undefined
}

function hasCredentials(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const credentials = value as Record<string, unknown>
  return ['apiKey', 'clientCredentials', 'device_code', 'access_token', 'refresh_token'].some(name => typeof credentials[name] === 'string' && credentials[name] !== '')
}

function safeCommandError(error: unknown, redactions: string[]): Error {
  if (typeof error !== 'object' || error === null) return new Error('The Blaxel CLI command failed')
  const candidate = error as { stderr?: unknown; message?: unknown }
  const detail = typeof candidate.stderr === 'string' && candidate.stderr.trim() !== ''
    ? candidate.stderr.trim().split('\n').at(-1)
    : typeof candidate.message === 'string' ? candidate.message : undefined
  let message = detail === undefined ? 'The Blaxel CLI command failed' : detail.replaceAll(/Bearer\s+\S+/gi, 'Bearer [redacted]')
  for (const secret of redactions) message = message.replaceAll(secret, '[redacted]')
  return new Error(message)
}

export class BlaxelSettingsManager {
  private readonly explicitBlEnv = process.env.BL_ENV
  private readonly browserLogins = new Map<string, PendingBrowserLogin>()
  private choicesCache?: { key: string; expiresAt: number; value: BlaxelSettingsChoices }

  constructor(private readonly paths: BlaxelSettingsPaths = defaultSettingsPaths()) {}

  async defaults(): Promise<SandboxDefaults> {
    try {
      return validateSandboxDefaults(JSON.parse(await readFile(this.paths.defaults, 'utf8')))
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('Saved Blaxel sandbox defaults are invalid JSON')
      if (error instanceof Error && !('code' in error && error.code === 'ENOENT')) throw error
      return environmentDefaults()
    }
  }

  async saveDefaults(value: unknown): Promise<SandboxDefaults> {
    const defaults = validateSandboxDefaults(value)
    const state = await this.status()
    if (!state.connection.authenticated) throw new Error('Connect a Blaxel workspace before saving sandbox defaults')
    if (!state.choices.verified) throw new Error('Blaxel could not verify these defaults for the active workspace')
    const availableImages = state.choices.images.filter(item => item.available !== false).map(item => item.value)
    const availableRegions = state.choices.regions.filter(item => item.available !== false).map(item => item.value)
    const availableTtls = state.choices.idleDeletion.filter(item => item.available !== false).map(item => item.value)
    if (!availableImages.includes(defaults.image)) throw new Error('Choose a container image available to this workspace')
    if (!state.choices.memory.includes(defaults.memory)) throw new Error(`Choose memory within this workspace's ${String(state.choices.maxMemory ?? 'available')} MB limit`)
    if (defaults.region !== undefined && !availableRegions.includes(defaults.region)) throw new Error('Choose a region available to this workspace')
    if (defaults.ttl !== undefined && !availableTtls.includes(defaults.ttl)) throw new Error('Choose a maximum lifetime available to this workspace')
    await mkdir(dirname(this.paths.defaults), { recursive: true, mode: 0o700 })
    const temporary = `${this.paths.defaults}.${String(process.pid)}.tmp`
    await writeFile(temporary, `${JSON.stringify(defaults, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.paths.defaults)
    return defaults
  }

  async status(): Promise<BlaxelSettingsStatus> {
    const cli = await readCliConfiguration(this.paths.cliConfig)
    const environmentSource = authEnvironmentSource()
    const envWorkspace = process.env.BL_WORKSPACE?.trim() || undefined
    const selected = cli.workspaces.find(item => item.name === cli.current)
    const source = environmentSource ?? (hasCredentials(selected?.credentials) ? 'cli' : 'none')
    const workspace = envWorkspace ?? cli.current
    const development = (process.env.BL_ENV ?? selected?.env) === 'dev'
    const defaults = await this.defaults()
    return {
      connection: {
        authenticated: source !== 'none' && workspace !== undefined,
        source,
        ...(workspace === undefined ? {} : { workspace }),
        environment: development ? 'development' : 'production',
        profiles: cli.workspaces.flatMap(item => typeof item.name === 'string' && hasCredentials(item.credentials) ? [item.name] : []),
        managedByEnvironment: environmentSource !== undefined || envWorkspace !== undefined,
      },
      defaults,
      choices: await this.choices(source !== 'none' && workspace !== undefined, workspace, defaults),
    }
  }

  async beginBrowserLogin(): Promise<BrowserLoginState> {
    this.assertMutableAuthentication()
    const environment = await this.currentEnvironment()
    const response = await fetch(`${this.apiBaseUrl(environment)}/login/device`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: 'blaxel', scope: 'offline_access' }),
    })
    const body = await this.readJson(response)
    const deviceCode = this.requiredResponseText(body.device_code, 'device code')
    const authorizationUrl = this.requiredResponseUrl(body.verification_uri_complete)
    const interval = typeof body.interval === 'number' && body.interval > 0 ? body.interval : 3
    const expiresIn = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 180
    const id = randomUUID()
    this.browserLogins.set(id, {
      id,
      authorizationUrl,
      deviceCode,
      environment,
      expiresAt: Date.now() + expiresIn * 1000,
      intervalMs: interval * 1000,
      nextPollAt: Date.now(),
    })
    return { id, state: 'waiting', authorizationUrl }
  }

  async pollBrowserLogin(value: unknown): Promise<BrowserLoginState> {
    this.assertMutableAuthentication()
    const id = this.validateFlowId(value)
    const flow = this.browserLogins.get(id)
    if (flow === undefined) throw new Error('This browser sign-in has expired. Start again.')
    if (flow.expiresAt <= Date.now()) {
      this.browserLogins.delete(id)
      throw new Error('Browser sign-in timed out. Start again.')
    }
    if (flow.workspaces !== undefined) return { id, state: 'choose-workspace', workspaces: flow.workspaces }
    if (flow.nextPollAt > Date.now()) return { id, state: 'waiting' }
    flow.nextPollAt = Date.now() + flow.intervalMs

    const response = await fetch(`${this.apiBaseUrl(flow.environment)}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: 'blaxel',
        device_code: flow.deviceCode,
      }),
    })
    const body = await this.readJson(response, true)
    if (response.status === 202 || body.error === 'authorization_pending') return { id, state: 'waiting' }
    if (!response.ok) throw new Error('Blaxel browser sign-in was not approved')
    flow.tokens = {
      accessToken: this.requiredResponseText(body.access_token, 'access token'),
      refreshToken: this.requiredResponseText(body.refresh_token, 'refresh token'),
      expiresIn: typeof body.expires_in === 'number' ? body.expires_in : 3600,
      deviceCode: flow.deviceCode,
    }
    flow.workspaces = await this.listOAuthWorkspaces(flow.environment, flow.tokens.accessToken)
    if (flow.workspaces.length === 0) throw new Error('No Blaxel workspaces are available for this account')
    return { id, state: 'choose-workspace', workspaces: flow.workspaces }
  }

  async completeBrowserLogin(flowValue: unknown, workspaceValue: unknown): Promise<BlaxelSettingsStatus> {
    this.assertMutableAuthentication()
    const id = this.validateFlowId(flowValue)
    const workspace = validateWorkspace(workspaceValue)
    const flow = this.browserLogins.get(id)
    if (flow?.tokens === undefined || flow.workspaces === undefined) throw new Error('Finish browser sign-in first')
    const selected = flow.workspaces.find(item => item.value === workspace)
    if (selected === undefined) throw new Error('Choose a workspace returned by Blaxel')
    await this.saveOAuthCredentials(workspace, selected.detail, flow.tokens, flow.environment)
    this.browserLogins.delete(id)
    await this.resetSdk(workspace)
    this.choicesCache = undefined
    return await this.status()
  }

  async switchWorkspace(value: unknown): Promise<BlaxelSettingsStatus> {
    this.assertMutableAuthentication()
    const workspace = validateWorkspace(value)
    await this.runCli(['workspaces', workspace, '--skip-version-warning'])
    await this.resetSdk(workspace)
    this.choicesCache = undefined
    return await this.status()
  }

  async login(workspaceValue: unknown, apiKeyValue: unknown): Promise<BlaxelSettingsStatus> {
    this.assertMutableAuthentication()
    const workspace = validateWorkspace(workspaceValue)
    if (typeof apiKeyValue !== 'string' || apiKeyValue.trim() === '' || apiKeyValue.length > 8192 || apiKeyValue.includes('\0')) {
      throw new Error('A valid Blaxel API key is required')
    }
    await this.runCli(
      ['login', workspace, '--skip-version-warning'],
      { BL_API_KEY: apiKeyValue, BL_WORKSPACE: undefined, BL_CLIENT_CREDENTIALS: undefined },
      [apiKeyValue],
    )
    await this.resetSdk(workspace)
    this.choicesCache = undefined
    return await this.status()
  }

  async logout(workspaceValue: unknown): Promise<BlaxelSettingsStatus> {
    this.assertMutableAuthentication()
    const workspace = validateWorkspace(workspaceValue)
    await this.runCli(['logout', workspace, '--skip-version-warning'])
    sdkSettings.setConfig({})
    sdkSettings.credentials = null
    this.choicesCache = undefined
    return await this.status()
  }

  async testConnection(): Promise<{ workspace: string }> {
    const state = await this.status()
    if (!state.connection.authenticated || state.connection.workspace === undefined) throw new Error('Connect a Blaxel workspace first')
    await this.refreshAuthentication(state.connection.workspace)
    const result = await listSandboxes({ query: { limit: 1 } })
    if (result.error !== undefined) throw new Error('Blaxel rejected this connection')
    return { workspace: state.connection.workspace }
  }

  async refreshAuthentication(workspaceValue?: unknown): Promise<void> {
    const workspace = workspaceValue === undefined ? undefined : validateWorkspace(workspaceValue)
    if (authEnvironmentSource() !== undefined || process.env.BL_WORKSPACE !== undefined) {
      sdkSettings.setConfig({})
      sdkSettings.credentials = null
      return
    }
    const cli = await readCliConfiguration(this.paths.cliConfig)
    const selectedWorkspace = workspace ?? cli.current
    if (selectedWorkspace === undefined) throw new Error('Connect a Blaxel workspace first')
    const selected = cli.workspaces.find(item => item.name === selectedWorkspace)
    if (!hasCredentials(selected?.credentials)) throw new Error('Sign in to this Blaxel workspace again')
    if (typeof selected?.credentials === 'object' && selected.credentials !== null && typeof (selected.credentials as Record<string, unknown>).device_code === 'string') {
      try {
        await this.runCli(['token', '--workspace', selectedWorkspace, '--skip-version-warning'])
      } catch (error) {
        if (/refresh_token|refresh token|unauthorized|expired/i.test(error instanceof Error ? error.message : String(error))) {
          throw new Error('This Blaxel sign-in has expired. Sign in to Blaxel again.')
        }
        throw error
      }
    }
    await this.resetSdk(selectedWorkspace)
  }

  private assertMutableAuthentication(): void {
    if (authEnvironmentSource() !== undefined || process.env.BL_WORKSPACE !== undefined) {
      throw new Error('Blaxel authentication is managed by this process environment')
    }
  }

  private async choices(authenticated: boolean, workspace: string | undefined, defaults: SandboxDefaults): Promise<BlaxelSettingsChoices> {
    const base: BlaxelSettingsChoices = {
      images: [{ value: defaults.image, label: defaults.image }],
      memory: MEMORY_CHOICES.includes(defaults.memory) ? MEMORY_CHOICES : [...MEMORY_CHOICES, defaults.memory].sort((a, b) => a - b),
      regions: [{ value: '', label: 'Automatic' }, ...(defaults.region === undefined ? [] : [{ value: defaults.region, label: defaults.region }])],
      idleDeletion: TTL_CHOICES,
      verified: false,
    }
    if (!authenticated || workspace === undefined) return base
    const key = `${workspace}:${process.env.BL_ENV ?? ''}`
    if (this.choicesCache?.key === key && this.choicesCache.expiresAt > Date.now()) return this.choicesCache.value
    try {
      await this.refreshAuthentication(workspace)
      const [hub, configuration, workspaceResponse] = await Promise.all([
        listSandboxHubDefinitions(),
        getConfiguration(),
        getWorkspace({ path: { workspaceName: workspace } }),
      ])
      if (hub.error !== undefined || configuration.error !== undefined || workspaceResponse.error !== undefined) throw new Error('Blaxel did not return platform choices')
      const accountId = workspaceResponse.data?.accountId
      if (typeof accountId !== 'string' || accountId === '') throw new Error('Blaxel did not return this workspace account')
      const [quotasResponse, accountResponse] = await Promise.all([
        fetch(`${sdkSettings.baseUrl}/quotas/account/${encodeURIComponent(accountId)}`, { headers: sdkSettings.headers }),
        fetch(`${sdkSettings.baseUrl}/accounts/${encodeURIComponent(accountId)}`, { headers: sdkSettings.headers }),
      ])
      if (!quotasResponse.ok || !accountResponse.ok) throw new Error('Blaxel did not return this account tier and quotas')
      const quotasValue: unknown = await quotasResponse.json()
      const accountValue: unknown = await accountResponse.json()
      if (!Array.isArray(quotasValue)) throw new Error('Blaxel returned invalid account quotas')
      const quotas = quotasValue as AccountQuota[]
      const quota = (resourceType: string): number | undefined => {
        const value = quotas.find(item => item.resourceType === resourceType)?.value
        return typeof value === 'number' && Number.isFinite(value) ? value : undefined
      }
      const maxMemory = quota('memory')
      if (maxMemory === undefined || maxMemory < 128) throw new Error('Blaxel did not return a usable sandbox memory quota')
      const maxTtlDays = quota('sandbox_ttl')
      const enforcedTtl = quota('sandbox_enforced_ttl') === 1
      const account = typeof accountValue === 'object' && accountValue !== null ? accountValue as AccountSummary : {}
      const plan = typeof account.spec?.subscription?.plan === 'string' ? account.spec.subscription.plan : undefined
      const tier = typeof account.spec?.subscription?.tier === 'string' ? account.spec.subscription.tier : undefined
      const images: BlaxelChoice[] = (hub.data ?? [])
        .filter(item => item.hidden !== true && item.coming_soon !== true && item.enterprise !== true && typeof item.image === 'string' && item.image !== '' && (typeof item.memory !== 'number' || item.memory <= maxMemory))
        .map(item => ({
          value: item.image as string,
          label: typeof item.displayName === 'string' && item.displayName !== '' ? item.displayName : item.image as string,
          ...(typeof item.description === 'string' && item.description !== '' ? { detail: item.description } : {}),
          ...(typeof item.memory === 'number' ? { recommendedMemory: item.memory } : {}),
        }))
        .sort((a, b) => a.label.localeCompare(b.label))
      if (!images.some(item => item.value === defaults.image)) images.unshift({ value: defaults.image, label: `${defaults.image} (unavailable)`, available: false })
      const regions: BlaxelChoice[] = (configuration.data?.regions ?? [])
        .filter(item => (item as { allowed?: unknown }).allowed === true && typeof item.name === 'string' && item.name !== '')
        .map(item => ({
          value: item.name as string,
          label: typeof item.location === 'string' && item.location !== '' ? `${item.location} (${item.name as string})` : item.name as string,
        }))
        .sort((a, b) => a.label.localeCompare(b.label))
      if (defaults.region !== undefined && !regions.some(item => item.value === defaults.region)) regions.unshift({ value: defaults.region, label: `${defaults.region} (unavailable)`, available: false })
      const memory = MEMORY_CHOICES.filter(value => value <= maxMemory)
      if (defaults.memory <= maxMemory && !memory.includes(defaults.memory)) memory.push(defaults.memory)
      memory.sort((a, b) => a - b)
      const idleDeletion: BlaxelChoice[] = TTL_CHOICES
        .filter(item => item.value === '' || maxTtlDays === undefined || maxTtlDays < 0 || durationDays(item.value) <= maxTtlDays)
        .map(item => item.value === '' ? { ...item, label: enforcedTtl && maxTtlDays !== undefined ? `Platform default (${String(maxTtlDays)} days)` : 'No maximum' } : item)
      if (defaults.ttl !== undefined && !idleDeletion.some(item => item.value === defaults.ttl)) idleDeletion.unshift({ value: defaults.ttl, label: `${defaults.ttl} (unavailable)`, available: false })
      const value: BlaxelSettingsChoices = {
        images,
        memory,
        regions: [{ value: '', label: 'Automatic' }, ...regions],
        idleDeletion,
        verified: true,
        workspace,
        ...(plan === undefined ? {} : { plan }),
        ...(tier === undefined ? {} : { tier }),
        maxMemory,
        ...(maxTtlDays === undefined ? {} : { maxTtlDays }),
      }
      this.choicesCache = { key, expiresAt: Date.now() + 5 * 60_000, value }
      return value
    } catch (error) {
      return { ...base, unavailable: error instanceof Error ? error.message : 'Platform choices are temporarily unavailable' }
    }
  }

  private async currentEnvironment(): Promise<'production' | 'development'> {
    const cli = await readCliConfiguration(this.paths.cliConfig)
    const selected = cli.workspaces.find(item => item.name === cli.current)
    return (process.env.BL_ENV ?? selected?.env) === 'dev' ? 'development' : 'production'
  }

  private apiBaseUrl(environment: 'production' | 'development'): string {
    return process.env.BL_API_URL?.replace(/\/$/, '') ?? (environment === 'development' ? 'https://api.blaxel.dev/v0' : 'https://api.blaxel.ai/v0')
  }

  private async readJson(response: Response, allowError = false): Promise<Record<string, unknown>> {
    let value: unknown
    try {
      value = await response.json()
    } catch {
      throw new Error('Blaxel returned an invalid sign-in response')
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Blaxel returned an invalid sign-in response')
    if (!allowError && !response.ok) throw new Error('Could not start Blaxel browser sign-in')
    return value as Record<string, unknown>
  }

  private requiredResponseText(value: unknown, name: string): string {
    if (typeof value !== 'string' || value === '' || value.length > 16_384) throw new Error(`Blaxel did not return a valid ${name}`)
    return value
  }

  private requiredResponseUrl(value: unknown): string {
    const url = new URL(this.requiredResponseText(value, 'authorization URL'))
    if (url.protocol !== 'https:') throw new Error('Blaxel returned an unsafe authorization URL')
    return url.toString()
  }

  private validateFlowId(value: unknown): string {
    if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/.test(value)) throw new Error('A valid browser sign-in is required')
    return value
  }

  private async listOAuthWorkspaces(environment: 'production' | 'development', accessToken: string): Promise<BlaxelChoice[]> {
    const response = await fetch(`${this.apiBaseUrl(environment)}/workspaces`, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) throw new Error('Blaxel could not list this account’s workspaces')
    const body: unknown = await response.json()
    if (!Array.isArray(body)) throw new Error('Blaxel returned an invalid workspace list')
    return body.flatMap(item => {
      if (typeof item !== 'object' || item === null) return []
      const candidate = item as Record<string, unknown>
      if (typeof candidate.name !== 'string' || !WORKSPACE_NAME.test(candidate.name)) return []
      const label = typeof candidate.displayName === 'string' && candidate.displayName !== '' ? candidate.displayName : candidate.name
      return [{ value: candidate.name, label, ...(typeof candidate.id === 'string' ? { detail: candidate.id } : {}) }]
    }).sort((a, b) => a.label.localeCompare(b.label))
  }

  private async saveOAuthCredentials(workspace: string, workspaceId: string | undefined, tokens: OAuthTokens, environment: 'production' | 'development'): Promise<void> {
    const document = await readCliDocument(this.paths.cliConfig)
    const workspaces = Array.isArray(document.workspaces) ? document.workspaces.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null) : []
    const credentials = {
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expires_in: tokens.expiresIn,
      device_code: tokens.deviceCode,
    }
    const existing = workspaces.find(item => item.name === workspace)
    if (existing === undefined) {
      workspaces.push({ name: workspace, ...(workspaceId === undefined ? {} : { id: workspaceId }), credentials, ...(environment === 'development' ? { env: 'dev' } : {}) })
    } else {
      existing.credentials = credentials
      if (workspaceId !== undefined) existing.id = workspaceId
      if (environment === 'development') existing.env = 'dev'
      else delete existing.env
    }
    const output = { ...document, context: { ...document.context, workspace }, workspaces }
    await mkdir(dirname(this.paths.cliConfig), { recursive: true, mode: 0o700 })
    const temporary = `${this.paths.cliConfig}.${String(process.pid)}.tmp`
    await writeFile(temporary, stringifyYaml(output), { mode: 0o600 })
    await rename(temporary, this.paths.cliConfig)
  }

  private async resetSdk(workspace: string): Promise<void> {
    const cli = await readCliConfiguration(this.paths.cliConfig)
    const selected = cli.workspaces.find(item => item.name === workspace)
    if (this.explicitBlEnv === undefined) {
      if (selected?.env === 'dev') process.env.BL_ENV = 'dev'
      else delete process.env.BL_ENV
    }
    sdkSettings.setConfig({})
    sdkSettings.credentials = null
  }

  private async runCli(args: string[], overrides: Record<string, string | undefined> = {}, redactions: string[] = []): Promise<void> {
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const [name, value] of Object.entries(overrides)) {
      if (value === undefined) delete env[name]
      else env[name] = value
    }
    try {
      await runFile('bl', args, { env, timeout: 120_000, maxBuffer: 1024 * 1024 })
    } catch (error) {
      throw safeCommandError(error, redactions)
    }
  }
}
