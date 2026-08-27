import type { BlaxelHttpRequest, BlaxelHttpResponse } from './context.js'

const ACTION_HEADER = 'x-dsh-blaxel-action'
const API_PREFIX = '/blaxel/api/'
const MAX_BODY_BYTES = 8 * 1024
const LOCAL_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/

export type AuthorizedAction =
  | 'check' | 'open' | 'close' | 'move' | 'divergence' | 'sync-local' | 'configure' | 'workspace' | 'login' | 'logout' | 'test'
  | 'oauth-start' | 'oauth-poll' | 'oauth-complete' | 'install-skills' | 'mcp-login' | 'mcp-logout'
  | 'model-readiness' | 'model-credential'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function header(req: BlaxelHttpRequest, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

export function routeAction(req: BlaxelHttpRequest): string {
  const pathname = (req.url ?? '').split('?', 1)[0]
  return pathname.startsWith(API_PREFIX) ? pathname.slice(API_PREFIX.length) : ''
}

/** A same-origin read: no action header, but never a cross-site caller. */
export function permitsRead(req: BlaxelHttpRequest): boolean {
  const origin = header(req, 'origin')
  return origin === undefined || LOCAL_ORIGIN.test(origin)
}

export function permitsAction(req: BlaxelHttpRequest, action: AuthorizedAction): boolean {
  return header(req, ACTION_HEADER) === action && permitsRead(req)
}

export function writeJson(res: BlaxelHttpResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: BlaxelHttpRequest): Promise<Record<string, unknown>> {
  const body = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let failed = false
    req.on('data', (chunk) => {
      if (failed) return
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        failed = true
        reject(new Error('Request body is too large'))
      } else {
        chunks.push(chunk)
      }
    })
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)) })
    req.on('error', reject)
  })

  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    throw new Error('Request body must be JSON')
  }
  if (!isRecord(parsed)) throw new Error('Request body must be JSON')
  return parsed
}

export async function readConfigurationRequest(req: BlaxelHttpRequest): Promise<{ defaults: unknown }> {
  const body = await readJsonBody(req)
  return { defaults: body.defaults }
}

export async function readWorkspaceRequest(req: BlaxelHttpRequest): Promise<{ workspace: unknown }> {
  const body = await readJsonBody(req)
  return { workspace: body.workspace }
}

export async function readLoginRequest(req: BlaxelHttpRequest): Promise<{ workspace: unknown; apiKey: unknown }> {
  const body = await readJsonBody(req)
  return { workspace: body.workspace, apiKey: body.apiKey }
}

export async function readBrowserLoginRequest(req: BlaxelHttpRequest): Promise<{ flowId: unknown; workspace?: unknown }> {
  const body = await readJsonBody(req)
  return { flowId: body.flowId, ...(body.workspace === undefined ? {} : { workspace: body.workspace }) }
}

export interface LaunchRequest {
  cwd: string
  title?: string
}

function workspaceCwd(body: Record<string, unknown>): string {
  const cwd = body.cwd
  if (typeof cwd !== 'string' || cwd.length > 4096) throw new Error('A valid session workspace is required')
  return cwd
}

function sessionTitle(body: Record<string, unknown>): string | undefined {
  const value = body.title
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > 500 || value.includes('\0')) throw new Error('A valid session title is required')
  const title = value.trim()
  return title === '' ? undefined : title
}

export async function readLaunchRequest(req: BlaxelHttpRequest): Promise<LaunchRequest> {
  const body = await readJsonBody(req)
  const title = sessionTitle(body)
  return { cwd: workspaceCwd(body), ...(title === undefined ? {} : { title }) }
}

export async function readMoveRequest(req: BlaxelHttpRequest): Promise<LaunchRequest & { sessionId: string }> {
  const body = await readJsonBody(req)
  const cwd = workspaceCwd(body)
  const sessionId = body.sessionId
  if (
    typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 512
    || sessionId.includes('\0') || sessionId.includes('/') || sessionId.includes('\\')
  ) {
    throw new Error('A valid session id is required')
  }
  const title = sessionTitle(body)
  return { cwd, sessionId, ...(title === undefined ? {} : { title }) }
}

export async function readSessionRequest(req: BlaxelHttpRequest): Promise<{ sessionId: string }> {
  const body = await readJsonBody(req)
  return { sessionId: sessionIdOf(body) }
}

function sessionIdOf(body: Record<string, unknown>): string {
  const sessionId = body.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 512 || sessionId.includes('\0') || sessionId.includes('/') || sessionId.includes('\\')) {
    throw new Error('A valid session id is required')
  }
  return sessionId
}

export async function readModelCredentialRequest(req: BlaxelHttpRequest): Promise<{ sessionId: string; credential: string }> {
  const body = await readJsonBody(req)
  const credential = body.credential
  if (typeof credential !== 'string' || credential.trim() === '' || credential.length > 4096 || credential.includes('\0')) {
    throw new Error('A valid model credential is required')
  }
  return { sessionId: sessionIdOf(body), credential: credential.trim() }
}
