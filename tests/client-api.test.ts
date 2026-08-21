import { afterEach, describe, expect, it, vi } from 'vitest'
import { getStatus, openWorkspace } from '../src/client/api.js'

afterEach(() => vi.unstubAllGlobals())

describe('Blaxel browser API', () => {
  it('sends an authorized workspace launch request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      url: 'http://127.0.0.1:4567',
      workspace: {
        cwd: '/repo',
        repoRoot: '/repo',
        remoteCwd: '/workspace',
        fileCount: 12,
        skippedSensitive: 1,
      },
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(openWorkspace('/repo')).resolves.toMatchObject({ url: 'http://127.0.0.1:4567' })
    expect(fetchMock).toHaveBeenCalledWith('/blaxel/api/open', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dsh-blaxel-action': 'open',
      },
      body: JSON.stringify({ cwd: '/repo' }),
    })
  })

  it('turns failed and malformed responses into client errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      error: 'Git worktree required',
    }), { status: 422 })))
    await expect(getStatus()).rejects.toThrow('Git worktree required')
  })
})
