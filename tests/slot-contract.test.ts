import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { SandboxSessionStatus, Status } from '../src/client/api.js'
import type { ClientSessionListState, ClientSessionSnapshot, SessionSlotProps } from '../src/client/context.js'

const bridge = vi.hoisted(() => ({ status: undefined as Status | undefined }))

vi.mock('../src/client/useBlaxelStatus.js', () => ({
  useBlaxelStatus: () => bridge.status,
  refreshBlaxelStatus: () => undefined,
}))

import { BlaxelComposerAction, sandboxChip } from '../src/client/BlaxelComposerAction.js'
import { BlaxelSandboxBanner } from '../src/client/BlaxelSandboxBanner.js'

const list: ClientSessionListState = {
  ids: ['s1'],
  current: 's1',
  byId: { s1: { blank: false, cwd: '/repo', displayTitle: 'Verify the sandbox' } },
}

/** Exactly what DSH 0.1.2 hands a `scope: 'session'` entry: identity plus selector hooks, no `session` object. */
function slotProps(running = false): SessionSlotProps {
  const snapshot: ClientSessionSnapshot = { sessionId: 's1', running }
  return {
    sessionId: 's1',
    useSession: selector => selector(snapshot),
    useSessions: selector => selector(list),
  }
}

function sandbox(state: SandboxSessionStatus['state']): Status {
  return {
    ok: true,
    settings: {} as Status['settings'],
    sandboxes: [{
      sessionId: 's1', workspace: 'main', environment: 'production', state,
      sandbox: { name: 'dsh-abc', cwd: '/workspace/repo', workspaceRoot: '/workspace' },
      live: { processes: 0 },
    } as unknown as SandboxSessionStatus],
  }
}

describe('DSH 0.1.2 session slot contract', () => {
  it('offers to move a local session to Blaxel without a session object prop', () => {
    bridge.status = { ok: true, sandboxes: [], settings: {} as Status['settings'] }
    const html = renderToStaticMarkup(createElement(BlaxelComposerAction, {
      ...slotProps(), openSession: () => undefined, setComposerBlock: () => undefined,
    }))
    expect(html).toContain('Move to Blaxel')
  })

  it('shows a connected chip for a ready sandbox and a live Reconnect for a lost one', () => {
    bridge.status = sandbox('ready')
    const ready = renderToStaticMarkup(createElement(BlaxelComposerAction, {
      ...slotProps(), openSession: () => undefined, setComposerBlock: () => undefined,
    }))
    expect(ready).toContain('data-blaxel-sandbox-chip="ready"')
    expect(ready).toContain('On Blaxel')
    expect(ready).toMatch(/<button[^>]*data-blaxel-sandbox-chip="ready"[^>]*disabled/)

    bridge.status = sandbox('failed')
    const failed = renderToStaticMarkup(createElement(BlaxelComposerAction, {
      ...slotProps(), openSession: () => undefined, setComposerBlock: () => undefined,
    }))
    expect(failed).toContain('Reconnect Blaxel')
    expect(failed).not.toMatch(/<button[^>]*data-blaxel-sandbox-chip="failed"[^>]*disabled/)
  })

  it('renders the banner from the standard sessionId prop alone', () => {
    bridge.status = sandbox('failed')
    const html = renderToStaticMarkup(createElement(BlaxelSandboxBanner, { sessionId: 's1', setUnavailableBlock: () => undefined }))
    expect(html).toContain('Sandbox unavailable')
    expect(html).toContain('Reconnect to sandbox')
    expect(html).toContain('Continue locally')
  })

  it('names every sandbox state so connection is never invisible', () => {
    expect(sandboxChip('ready').label).toBe('On Blaxel')
    expect(sandboxChip('failed').label).toBe('Reconnect Blaxel')
    expect(sandboxChip('restoring').label).toBe('Connecting…')
  })
})
