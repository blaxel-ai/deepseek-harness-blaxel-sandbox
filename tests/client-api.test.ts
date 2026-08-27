import { afterEach, describe, expect, it, vi } from 'vitest'
import { getModelReadiness, getStatus, inspectBlaxelChanges, moveBlaxelChangesLocal, moveSession, openWorkspace, saveModelCredential } from '../src/client/api.js'

afterEach(() => vi.unstubAllGlobals())

describe('Blaxel browser API', () => {
  it('sends an authorized workspace launch request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      sessionId: 'sandbox-session',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(openWorkspace('/repo', 'session-local')).resolves.toEqual({ ok: true, sessionId: 'sandbox-session' })
    expect(fetchMock).toHaveBeenCalledWith('/blaxel/api/open', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dsh-blaxel-action': 'open',
      },
      body: JSON.stringify({ cwd: '/repo', sessionId: 'session-local' }),
    })
  })

  it('sends the session id with an authorized move request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      sessionId: 'sandbox-session',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(moveSession('/repo', 'session-1')).resolves.toEqual({ ok: true, sessionId: 'sandbox-session' })
    expect(fetchMock).toHaveBeenCalledWith('/blaxel/api/move', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dsh-blaxel-action': 'move',
      },
      body: JSON.stringify({ cwd: '/repo', sessionId: 'session-1' }),
    })
  })

  it('surfaces a refused move as its own message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      error: 'This session has no saved log yet, so there is nothing to move',
    }), { status: 422 })))
    await expect(moveSession('/repo', 'session-1')).rejects.toThrow('nothing to move')
  })

  it('inspects and moves sandbox changes back to the same local worktree', async () => {
    const divergence = { changed: 2, files: [], truncated: false, checkedAt: '2026-08-25T00:00:00.000Z' }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, divergence }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, repoRoot: '/repo', divergence }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(inspectBlaxelChanges('session-1')).resolves.toEqual(divergence)
    await expect(moveBlaxelChangesLocal('session-1')).resolves.toEqual({ repoRoot: '/repo', divergence })
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/blaxel/api/divergence', expect.objectContaining({
      headers: expect.objectContaining({ 'x-dsh-blaxel-action': 'divergence' }),
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/blaxel/api/sync-local', expect.objectContaining({
      headers: expect.objectContaining({ 'x-dsh-blaxel-action': 'sync-local' }),
    }))
  })

  it('checks model readiness and saves a missing credential through the plugin bridge', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        readiness: { kind: 'credential-missing', provider: 'openai', providerName: 'OpenAI', model: 'gpt', credentialRef: 'OPENAI_API_KEY', writable: true },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        readiness: { kind: 'ready', provider: 'openai', providerName: 'OpenAI', model: 'gpt' },
      }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getModelReadiness('session-1')).resolves.toMatchObject({ kind: 'credential-missing' })
    await expect(saveModelCredential('session-1', 'secret-key')).resolves.toMatchObject({ kind: 'ready' })
    expect(fetchMock).toHaveBeenLastCalledWith('/blaxel/api/model-credential', expect.objectContaining({
      body: JSON.stringify({ sessionId: 'session-1', credential: 'secret-key' }),
    }))
  })

  it('turns failed and malformed responses into client errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      error: 'Git worktree required',
    }), { status: 422 })))
    await expect(getStatus()).rejects.toThrow('Git worktree required')
  })
})
