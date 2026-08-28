import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import type { BlaxelHttpRequest } from '../src/web/context.js'
import { permitsAction, permitsRead, readMoveRequest } from '../src/web/http.js'

describe('report authorization', () => {
  const request = (headers: Record<string, string>): BlaxelHttpRequest =>
    ({ headers, on: () => request(headers) }) as unknown as BlaxelHttpRequest

  it('requires the matching action header and a local origin', () => {
    for (const action of ['check', 'open', 'close', 'move', 'divergence', 'sync-local', 'configure', 'workspace', 'login', 'logout', 'test', 'oauth-start', 'oauth-poll', 'oauth-complete', 'install-skills', 'mcp-login', 'mcp-logout', 'model-readiness', 'model-credential'] as const) {
      expect(permitsAction(request({ 'x-dsh-blaxel-action': action }), action)).toBe(true)
      expect(permitsAction(request({ 'x-dsh-blaxel-action': action, origin: 'http://127.0.0.1:5173' }), action)).toBe(true)
      expect(permitsAction(request({ 'x-dsh-blaxel-action': action, origin: 'https://evil.example' }), action)).toBe(false)
      expect(permitsAction(request({ 'x-dsh-blaxel-action': action === 'open' ? 'move' : 'open' }), action)).toBe(false)
      expect(permitsAction(request({}), action)).toBe(false)
    }
  })

  it('allows the status read from a local origin only', () => {
    expect(permitsRead(request({}))).toBe(true)
    expect(permitsRead(request({ origin: 'http://localhost:5173' }))).toBe(true)
    expect(permitsRead(request({ origin: 'https://evil.example' }))).toBe(false)
  })
})

describe('request bodies', () => {
  const bodyRequest = (body: string): BlaxelHttpRequest => {
    const request = {
      headers: {},
      on(event: string, listener: (chunk?: Buffer) => void) {
        if (event === 'data') listener(Buffer.from(body, 'utf8'))
        if (event === 'end') listener()
        return request
      },
    }
    return request as unknown as BlaxelHttpRequest
  }

  it('accepts a workspace and session id, and rejects anything unusable as a path', async () => {
    await expect(readMoveRequest(bodyRequest(JSON.stringify({ cwd: '/repo', sessionId: 'session-1' }))))
      .resolves.toEqual({ cwd: '/repo', sessionId: 'session-1' })
    await expect(readMoveRequest(bodyRequest(JSON.stringify({ cwd: '/repo' })))).rejects.toThrow('valid session id')
    await expect(readMoveRequest(bodyRequest(JSON.stringify({ cwd: '/repo', sessionId: '../escape' }))))
      .rejects.toThrow('valid session id')
    await expect(readMoveRequest(bodyRequest(JSON.stringify({ cwd: '/repo', sessionId: 'a'.repeat(513) }))))
      .rejects.toThrow('valid session id')
    await expect(readMoveRequest(bodyRequest(JSON.stringify({ sessionId: 'session-1' })))).rejects.toThrow('session workspace')
    await expect(readMoveRequest(bodyRequest('nonsense'))).rejects.toThrow('must be JSON')
  })
})
