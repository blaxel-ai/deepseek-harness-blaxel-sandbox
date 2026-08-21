export interface LocalStatus {
  ok: true
  mode: 'local'
  child: {
    running: boolean
    url?: string
    workspace?: { cwd: string; repoRoot: string; remoteCwd: string }
  }
}

export interface RemoteStatus {
  ok: true
  mode: 'blaxel'
  state: 'ready'
  sandbox: { name: string; cwd: string; workspaceRoot: string; sourceCwd?: string }
}

export type Status = LocalStatus | RemoteStatus

export interface WorkspaceCheck {
  ok: true
  workspace: { cwd: string; repoRoot: string; relativeCwd: string; remoteCwd: string }
}

export interface OpenWorkspaceResult {
  ok: true
  url: string
  workspace: {
    cwd: string
    repoRoot: string
    remoteCwd: string
    fileCount: number
    skippedSensitive: number
  }
}

type Action = 'check' | 'open' | 'close'
type ApiSuccess = { ok: true }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function call<T extends ApiSuccess>(path: string, action?: Action, cwd?: string): Promise<T> {
  const response = await fetch(`/blaxel/api/${path}`, action === undefined ? undefined : {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-dsh-blaxel-action': action,
    },
    ...(cwd === undefined ? {} : { body: JSON.stringify({ cwd }) }),
  })
  const body: unknown = await response.json()
  if (!response.ok || !isRecord(body) || body.ok !== true) {
    const message = isRecord(body) && typeof body.error === 'string'
      ? body.error
      : `Request failed (${String(response.status)})`
    throw new Error(message)
  }
  return body as T
}

export async function getStatus(): Promise<Status> {
  return await call<Status>('status')
}

export async function checkWorkspace(cwd: string): Promise<WorkspaceCheck> {
  return await call<WorkspaceCheck>('check', 'check', cwd)
}

export async function openWorkspace(cwd: string): Promise<OpenWorkspaceResult> {
  return await call<OpenWorkspaceResult>('open', 'open', cwd)
}

export async function closeBlaxel(): Promise<void> {
  await call<ApiSuccess>('close', 'close')
}
