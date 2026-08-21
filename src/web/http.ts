import type { BlaxelHttpRequest, BlaxelHttpResponse } from './context.js'

const ACTION_HEADER = 'x-dsh-blaxel-action'
const API_PREFIX = '/blaxel/api/'
const MAX_BODY_BYTES = 8 * 1024

export type AuthorizedAction = 'check' | 'open' | 'close'

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

export function permitsAction(req: BlaxelHttpRequest, action: AuthorizedAction): boolean {
  if (header(req, ACTION_HEADER) !== action) return false
  const origin = header(req, 'origin')
  return origin === undefined || /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(origin)
}

export function writeJson(res: BlaxelHttpResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

export async function readWorkspaceCwd(req: BlaxelHttpRequest): Promise<string> {
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
  const cwd = isRecord(parsed) ? parsed.cwd : undefined
  if (typeof cwd !== 'string' || cwd.length > 4096) throw new Error('A valid session workspace is required')
  return cwd
}
