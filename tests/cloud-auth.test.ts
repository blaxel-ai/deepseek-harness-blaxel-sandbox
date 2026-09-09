import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createPreviewConnection, PreviewSessionAuth } from '../src/cloud-connection.js'

const origin = 'https://owned.preview.bl.run'
const token = 'x'.repeat(64)
function connection(expiry = Date.now() + 60_000) {
  const auth = new PreviewSessionAuth(origin, token, expiry, 'owned-sandbox', 'owned-workspace')
  return { auth, native: createPreviewConnection(new Context(), origin, auth) }
}
function request(headers: Record<string, string> = {}) {
  return { headers: { host: 'internal.gateway.example', origin, 'x-forwarded-host': 'owned.preview.bl.run', 'x-forwarded-proto': 'https', 'x-blaxel-auth-method': 'preview_token', 'x-blaxel-subject-type': 'preview_token', 'x-blaxel-subject-id': 'preview:owned', 'x-blaxel-workload-type': 'sandboxes', 'x-blaxel-workload': 'owned-sandbox', 'x-blaxel-workspace': 'owned-workspace', ...headers } }
}

describe('private cloud browser authentication', () => {
  it('accepts the preview login without a second cookie and retains native CSRF checks', () => {
    const { native } = connection()
    expect(native.requestRejection(request())).toBeUndefined()
    expect(native.requestRejection(request({ origin: 'https://attacker.example' }))).toBe(403)
    expect(native.requestRejection(request({ 'x-forwarded-host': 'other.preview.bl.run' }))).toBe(401)
    expect(native.requestRejection(request({ 'sec-fetch-site': 'cross-site' }))).toBe(403)
  })
  it('requires the exact preview, workload and workspace identity supplied by the private edge', () => {
    const { native } = connection()
    for (const key of ['x-forwarded-host', 'x-forwarded-proto', 'x-blaxel-auth-method', 'x-blaxel-subject-type', 'x-blaxel-subject-id', 'x-blaxel-workload-type', 'x-blaxel-workload', 'x-blaxel-workspace']) {
      expect(native.requestRejection(request({ [key]: '' }))).toBe(401)
      expect(native.requestRejection(request({ [key]: 'another-tenant' }))).toBe(401)
    }
    expect(native.requestRejection({ headers: { host: 'owned.preview.bl.run', cookie: `bl_preview_token=${token}` } })).toBe(401)
    expect(() => connection(Date.now() - 1).auth.authenticatedUrl(origin)).toThrow('expired')
    expect(() => connection().auth.authenticatedUrl('https://attacker.example')).toThrow('Unexpected')
  })
  it('exchanges a valid private URL for the clean root without issuing a competing cookie', () => {
    const { auth } = connection()
    let status = 0
    let responseHeaders: Readonly<Record<string, string>> = {}
    const response = { writeHead(code: number, headers?: Readonly<Record<string, string>>) { status = code; responseHeaders = headers ?? {} }, end() {} }
    expect(auth.authorizeIndex({ ...request({ cookie: '' }), method: 'GET', url: auth.authenticatedUrl(origin) }, response)).toBe(false)
    expect(status).toBe(303)
    expect(responseHeaders.location).toBe('/')
    expect(responseHeaders['set-cookie']).toBeUndefined()
    expect(auth.authorizeIndex({ ...request(), method: 'GET', url: '/' }, response)).toBe(true)
  })
})
