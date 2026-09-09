import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Context } from '@deepseek-ai/cordis'
import { API_PATH, HostConnectionService, type ConnectionIndexRequest, type ConnectionIndexResponse, type ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'

type NativeAuth = ConstructorParameters<typeof HostConnectionService>[2]
type AuthContract = Pick<NativeAuth, 'authenticatedUrl' | 'authorizeIndex' | 'isAuthenticated'>

function header(request: ConnectionTrustRequest, name: string): string | undefined {
  const value = request.headers instanceof Headers ? request.headers.get(name) : request.headers[name]
  return typeof value === 'string' ? value : undefined
}

/** The private preview cookie is the cloud login; no second Set-Cookie can be lost at the edge. */
export class PreviewSessionAuth implements AuthContract {
  constructor(private readonly origin: string, private readonly token: string, private readonly expiresAt: number, private readonly sandbox: string, private readonly workspace: string) {
    if (new URL(origin).protocol !== 'https:' || token.length < 32 || !Number.isFinite(expiresAt)) throw new Error('A private preview login is required for the cloud host')
  }

  authenticatedUrl(baseUrl: string): string {
    if (Date.now() >= this.expiresAt) throw new Error('The private cloud link expired. Reopen this session from the originating computer to renew access')
    if (new URL(baseUrl).origin !== this.origin) throw new Error('Unexpected cloud login origin')
    const url = new URL('/', this.origin)
    url.searchParams.set('bl_preview_token', this.token)
    return url.href
  }

  isAuthenticated(request: ConnectionTrustRequest): boolean {
    // The private preview edge validates the bearer token, removes its cookie,
    // and overwrites these identity headers before forwarding to this isolated VM.
    const hostname = new URL(this.origin).hostname
    return header(request, 'x-forwarded-host') === new URL(this.origin).host
      && header(request, 'x-forwarded-proto') === 'https'
      && header(request, 'x-blaxel-auth-method') === 'preview_token'
      && header(request, 'x-blaxel-subject-type') === 'preview_token'
      && header(request, 'x-blaxel-subject-id') === `preview:${hostname.split('.')[0]}`
      && header(request, 'x-blaxel-workload-type') === 'sandboxes'
      && header(request, 'x-blaxel-workload') === this.sandbox
      && header(request, 'x-blaxel-workspace') === this.workspace
  }

  publicHeaders(request: ConnectionTrustRequest): Record<string, string> {
    const headers: Record<string, string> = {}
    if (request.headers instanceof Headers) request.headers.forEach((value, key) => { headers[key] = value })
    else for (const [key, value] of Object.entries(request.headers)) if (typeof value === 'string') headers[key] = value
    headers.host = new URL(this.origin).host
    return headers
  }

  authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean {
    const url = new URL(request.url ?? '/', this.origin)
    const tokens = url.searchParams.getAll('bl_preview_token')
    if (request.method === 'GET' && url.pathname === '/' && this.isAuthenticated(request) && tokens.length > 0) {
      response.writeHead(303, { location: '/', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
      response.end()
      return false
    }
    if (this.isAuthenticated(request)) return true
    response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    response.end('Open this session using its private Blaxel link. If the link expired, open it again from the originating computer.')
    return false
  }
}

export function createPreviewConnection(ctx: Context, origin: string, auth: PreviewSessionAuth): HostConnectionService {
  class PreviewConnection extends HostConnectionService {
    requestRejection(request: ConnectionTrustRequest): 401 | 403 | undefined {
      if (!auth.isAuthenticated(request)) return 401
      return super.requestRejection({ headers: auth.publicHeaders(request) })
    }
  }
  return new PreviewConnection(ctx, [new URL(origin).host], auth as unknown as NativeAuth)
}

export const inject = ['webServer']

/** Reuse native RPC dispatch and its Host/Origin/CSRF fence with private-preview authentication. */
export function apply(ctx: Context): void {
  const origin = process.env.DSH_BLAXEL_PREVIEW_ORIGIN ?? ''
  const auth = new PreviewSessionAuth(origin, process.env.DSH_BLAXEL_BROWSER_TOKEN ?? '', Number(process.env.DSH_BLAXEL_BROWSER_EXPIRES), process.env.DSH_BLAXEL_SANDBOX_NAME ?? '', process.env.DSH_BLAXEL_WORKSPACE_NAME ?? '')
  // DSH pins this constructor to its internal BrowserAuth class, but consumes only AuthContract.
  // Keep this boundary pinned and exercised against the real native Connection service.
  const connection = createPreviewConnection(ctx, origin, auth)
  const handler = connection.createSharedFetchHandler(API_PATH)
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: API_PATH, handler: async (request, response) => {
    const req = request as IncomingMessage
    const res = response as ServerResponse
    const rejected = connection.requestRejection(req)
    if (rejected !== undefined) { res.writeHead(rejected); res.end('Authentication required'); return }
    const controller = new AbortController()
    res.once('close', () => { if (!res.writableEnded) controller.abort() })
    try {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk as Uint8Array)
        size += bytes.length
        if (size > 64 * 1024 * 1024) { res.writeHead(413, { connection: 'close' }); res.end('Request exceeds 64 MiB'); return }
        chunks.push(bytes)
      }
      const result = await handler.fetch(new Request(new URL(req.url ?? '/', origin), {
        method: req.method,
        headers: Object.fromEntries(Object.entries(req.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
        ...(size > 0 ? { body: Buffer.concat(chunks) } : {}), signal: controller.signal,
      }))
      const headers: Record<string, string> = {}
      result.headers.forEach((value, key) => { headers[key] = value })
      res.writeHead(result.status, headers)
      if (result.body === null) res.end()
      else await pipeline(Readable.fromWeb(result.body as import('node:stream/web').ReadableStream), res)
    } catch {
      if (!res.headersSent) res.writeHead(500)
      res.end('Cloud request failed')
    }
  } }))
}
