import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { closeBlaxel, getStatus, type Status } from './api.js'

type ViewStatus = Status | { mode: 'stopping' }

const card: CSSProperties = {
  background: 'var(--dsw-alias-bg-layer-1, #1f1f1f)',
  border: '1px solid var(--dsw-alias-border, #333)',
  borderRadius: 10,
  maxWidth: 620,
  padding: '18px 20px',
}

const secondaryButton: CSSProperties = {
  background: 'var(--dsw-alias-bg-button, #2a2a2a)',
  border: '1px solid var(--dsw-alias-border, #444)',
  borderRadius: 7,
  color: '#fff',
  cursor: 'pointer',
  fontSize: 14,
  fontWeight: 600,
  padding: '9px 14px',
}

function Badge(props: { active: boolean }): ReactNode {
  return <span style={{
    background: props.active ? 'rgba(52, 199, 89, 0.16)' : 'rgba(142, 142, 147, 0.18)',
    borderRadius: 999,
    color: props.active ? '#34c759' : 'var(--dsw-alias-label-secondary, #aaa)',
    fontSize: 12,
    fontWeight: 600,
    padding: '4px 9px',
  }}>{props.active ? 'Blaxel active' : 'Local execution'}</span>
}

export function BlaxelSettings(): ReactNode {
  const [status, setStatus] = useState<ViewStatus | undefined>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const refresh = useCallback(async () => {
    try {
      setStatus(await getStatus())
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 2_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const stopBlaxel = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      await closeBlaxel()
      if (status?.mode === 'blaxel') {
        setStatus({ mode: 'stopping' })
      } else {
        await refresh()
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const active = status?.mode === 'blaxel' || status?.mode === 'stopping'
  const child = status?.mode === 'local' ? status.child : undefined

  return <div style={{ color: 'var(--dsw-alias-label-primary, #eee)', maxWidth: 680 }}>
    <div style={{ alignItems: 'center', display: 'flex', gap: 10, marginBottom: 16 }}>
      <h2 style={{ fontSize: 18, margin: 0 }}>Blaxel Sandbox</h2>
      <Badge active={active} />
    </div>

    <div style={card}>
      {status === undefined && error === undefined ? <p>Checking execution mode…</p> : null}

      {status?.mode === 'local' ? <>
        <p style={{ marginTop: 0 }}>This DSH window is using your local filesystem and processes.</p>
        <p style={{ color: 'var(--dsw-alias-label-secondary, #aaa)', lineHeight: 1.5 }}>
          Use <strong>Open in Blaxel</strong> beside the chat input while working inside a Git repository. DSH snapshots that worktree and opens it as a separate sandbox session.
        </p>
        {child?.running === true && child.workspace !== undefined ? <dl style={{ display: 'grid', gridTemplateColumns: '110px 1fr', lineHeight: 1.8, margin: '14px 0' }}>
          <dt style={{ color: 'var(--dsw-alias-label-secondary, #aaa)' }}>Repository</dt><dd style={{ margin: 0 }}><code>{child.workspace.repoRoot}</code></dd>
          <dt style={{ color: 'var(--dsw-alias-label-secondary, #aaa)' }}>Workspace</dt><dd style={{ margin: 0 }}><code>{child.workspace.remoteCwd}</code></dd>
        </dl> : null}
        {child?.running === true ? <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 18 }}>
          {child.url !== undefined ? <button type="button" style={secondaryButton} onClick={() => window.open(child.url, '_blank')}>
            Open Blaxel window
          </button> : null}
          <button type="button" style={secondaryButton} disabled={busy} onClick={() => { void stopBlaxel() }}>
            {busy ? 'Stopping…' : 'Stop Blaxel window'}
          </button>
        </div> : null}
      </> : null}

      {status?.mode === 'blaxel' ? <>
        <p style={{ marginTop: 0 }}>This DSH window is isolated in Blaxel.</p>
        <dl style={{ display: 'grid', gridTemplateColumns: '110px 1fr', lineHeight: 1.8, margin: '14px 0' }}>
          <dt style={{ color: 'var(--dsw-alias-label-secondary, #aaa)' }}>Sandbox</dt><dd style={{ margin: 0 }}><code>{status.sandbox.name}</code></dd>
          <dt style={{ color: 'var(--dsw-alias-label-secondary, #aaa)' }}>Workspace</dt><dd style={{ margin: 0 }}><code>{status.sandbox.cwd}</code></dd>
          <dt style={{ color: 'var(--dsw-alias-label-secondary, #aaa)' }}>State</dt><dd style={{ margin: 0 }}>Ready</dd>
        </dl>
        <button type="button" style={secondaryButton} disabled={busy} onClick={() => { void stopBlaxel() }}>
          {busy ? 'Stopping…' : 'Stop sandbox and close DSH'}
        </button>
      </> : null}

      {status?.mode === 'stopping' ? <p>Stopping the Blaxel sandbox…</p> : null}
      {error !== undefined ? <p role="alert" style={{ color: '#ff6961', marginBottom: 0 }}>{error}</p> : null}
    </div>
  </div>
}
