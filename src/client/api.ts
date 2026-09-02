import type { ModelReadiness } from '../shared/model-readiness.js'

export type LaunchStep =
  | 'inspecting'
  | 'listing'
  | 'screening'
  | 'archiving'
  | 'session'
  | 'starting'
  | 'ready'

export interface LaunchProgress {
  kind: 'open' | 'move'
  step: LaunchStep
  files?: { screened: number; total: number; included: number; skipped: number; archived: number }
  archiveBytes?: number
  startedAt: string
  updatedAt: string
  error?: string
}

export interface LocalStatus {
  ok: true
  sandboxes: SandboxSessionStatus[]
  progress?: LaunchProgress
  settings: BlaxelSettingsStatus
}

export interface SandboxDefaults {
  image: string
  memory: number
  region?: string
  ttl?: string
}

export interface BlaxelConnection {
  authenticated: boolean
  source: 'api-key-environment' | 'client-credentials-environment' | 'blaxel-host' | 'cli' | 'none'
  workspace?: string
  environment: 'production' | 'development'
  profiles: string[]
  managedByEnvironment: boolean
}

export interface BlaxelSettingsStatus {
  connection: BlaxelConnection
  defaults: SandboxDefaults
  choices: {
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
  capabilities: BlaxelCapabilities
}

export interface BlaxelChoice {
  value: string
  label: string
  detail?: string
  recommendedMemory?: number
  available?: boolean
}

export interface BlaxelCapabilities {
  skills: { installed: boolean; upToDate?: boolean; names: string[]; checkError?: string }
  mcp: { connected: boolean; endpoint: string }
}

export interface BrowserLoginState {
  id: string
  state: 'waiting' | 'choose-workspace'
  authorizationUrl?: string
  workspaces?: BlaxelChoice[]
}

export interface SnapshotProvenance {
  repoRoot: string
  cwd: string
  remoteCwd: string
  fileCount: number
  skippedSensitive: number
  archiveBytes: number
  branch?: string
  commit?: string
}

export interface SandboxSessionStatus {
  sessionId: string
  title?: string
  workspace: string
  environment: 'production' | 'development'
  state: 'creating' | 'restoring' | 'ready' | 'failed'
  sandbox: {
    name: string
    cwd: string
    workspaceRoot: string
    sourceCwd?: string
    status?: string
    image?: string
    memory?: number
    region?: string
    ttl?: string
    createdAt?: string
    startedAt: string
    uptimeMs: number
    lastUsedAt?: string
    expiresIn?: number
  }
  provenance?: SnapshotProvenance
  live: { processes: number }
  error?: string
}

export type Status = LocalStatus

export interface WorkspaceCheck {
  ok: true
  workspace: { cwd: string; repoRoot: string; relativeCwd: string; remoteCwd: string }
}

export interface OpenWorkspaceResult {
  ok: true
  sessionId: string
}

export type MoveSessionResult = OpenWorkspaceResult

export interface DivergenceSummary {
  changed: number
  files: Array<{ status: string; path: string; from?: string }>
  truncated: boolean
  insertions?: number
  deletions?: number
  checkedAt: string
}

type Action =
  | 'check' | 'open' | 'close' | 'move' | 'divergence' | 'sync-local' | 'configure' | 'workspace' | 'login' | 'logout' | 'test'
  | 'oauth-start' | 'oauth-poll' | 'oauth-complete' | 'install-skills' | 'mcp-login' | 'mcp-logout'
  | 'model-readiness' | 'model-credential'
type ApiSuccess = { ok: true }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function call<T extends ApiSuccess>(path: string, action?: Action, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`/blaxel/api/${path}`, action === undefined ? undefined : {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-dsh-blaxel-action': action,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const payload: unknown = await response.json()
  if (!response.ok || !isRecord(payload) || payload.ok !== true) {
    const message = isRecord(payload) && typeof payload.error === 'string'
      ? payload.error
      : `Request failed (${String(response.status)})`
    throw new Error(message)
  }
  return payload as T
}

export async function getStatus(): Promise<Status> {
  return await call<Status>('status')
}

export async function checkWorkspace(cwd: string): Promise<WorkspaceCheck> {
  return await call<WorkspaceCheck>('check', 'check', { cwd })
}

export async function openWorkspace(cwd: string, sessionId: string, title?: string): Promise<OpenWorkspaceResult> {
  return await call<OpenWorkspaceResult>('open', 'open', { cwd, sessionId, ...(title === undefined ? {} : { title }) })
}

/** Atomically moves this native session's execution providers to a Blaxel sandbox. */
export async function moveSession(cwd: string, sessionId: string, title?: string): Promise<MoveSessionResult> {
  return await call<MoveSessionResult>('move', 'move', { cwd, sessionId, ...(title === undefined ? {} : { title }) })
}

export async function getModelReadiness(sessionId: string): Promise<ModelReadiness> {
  return (await call<ApiSuccess & { readiness: ModelReadiness }>('model-readiness', 'model-readiness', { sessionId })).readiness
}

export async function saveModelCredential(sessionId: string, credential: string): Promise<ModelReadiness> {
  return (await call<ApiSuccess & { readiness: ModelReadiness }>('model-credential', 'model-credential', {
    sessionId,
    credential,
  })).readiness
}

export async function closeBlaxel(sessionId: string): Promise<void> {
  await call<ApiSuccess>('close', 'close', { sessionId })
}

export async function inspectBlaxelChanges(sessionId: string): Promise<DivergenceSummary> {
  return (await call<ApiSuccess & { divergence: DivergenceSummary }>('divergence', 'divergence', { sessionId })).divergence
}

export async function moveBlaxelChangesLocal(sessionId: string): Promise<{ repoRoot: string; divergence: DivergenceSummary }> {
  const result = await call<ApiSuccess & { repoRoot: string; divergence: DivergenceSummary }>('sync-local', 'sync-local', { sessionId })
  return { repoRoot: result.repoRoot, divergence: result.divergence }
}

export async function saveBlaxelDefaults(defaults: SandboxDefaults): Promise<SandboxDefaults> {
  return (await call<ApiSuccess & { defaults: SandboxDefaults }>('configure', 'configure', { defaults })).defaults
}

export async function switchBlaxelWorkspace(workspace: string): Promise<BlaxelSettingsStatus> {
  return (await call<ApiSuccess & { settings: BlaxelSettingsStatus }>('workspace', 'workspace', { workspace })).settings
}

export async function loginBlaxel(workspace: string, apiKey: string): Promise<BlaxelSettingsStatus> {
  return (await call<ApiSuccess & { settings: BlaxelSettingsStatus }>('login', 'login', { workspace, apiKey })).settings
}

export async function logoutBlaxel(workspace: string): Promise<BlaxelSettingsStatus> {
  return (await call<ApiSuccess & { settings: BlaxelSettingsStatus }>('logout', 'logout', { workspace })).settings
}

export async function testBlaxelConnection(): Promise<{ workspace: string }> {
  return await call<ApiSuccess & { workspace: string }>('test', 'test')
}

export async function beginBlaxelBrowserLogin(): Promise<BrowserLoginState> {
  return (await call<ApiSuccess & { login: BrowserLoginState }>('oauth-start', 'oauth-start', {})).login
}

export async function pollBlaxelBrowserLogin(flowId: string): Promise<BrowserLoginState> {
  return (await call<ApiSuccess & { login: BrowserLoginState }>('oauth-poll', 'oauth-poll', { flowId })).login
}

export async function completeBlaxelBrowserLogin(flowId: string, workspace: string): Promise<BlaxelSettingsStatus> {
  return (await call<ApiSuccess & { settings: BlaxelSettingsStatus }>('oauth-complete', 'oauth-complete', { flowId, workspace })).settings
}

export async function installBlaxelSkills(): Promise<BlaxelCapabilities> {
  return (await call<ApiSuccess & { capabilities: BlaxelCapabilities }>('install-skills', 'install-skills', {})).capabilities
}

export async function connectBlaxelMcp(): Promise<BlaxelCapabilities> {
  return (await call<ApiSuccess & { capabilities: BlaxelCapabilities }>('mcp-login', 'mcp-login', {})).capabilities
}

export async function disconnectBlaxelMcp(): Promise<BlaxelCapabilities> {
  return (await call<ApiSuccess & { capabilities: BlaxelCapabilities }>('mcp-logout', 'mcp-logout', {})).capabilities
}
