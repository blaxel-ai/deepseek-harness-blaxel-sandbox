import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { checkWorkspace, getStatus, openWorkspace } from './api.js'
import type { ClientSessionListState } from './context.js'

interface BlaxelComposerActionProps {
  session: { sessionId: string; running: boolean }
  useSessions: <T>(selector: (state: ClientSessionListState) => T) => T
}

type Phase = 'checking' | 'eligible' | 'ineligible' | 'active'

const actionButton: CSSProperties = {
  alignItems: 'center',
  background: 'var(--dsw-alias-bg-button, transparent)',
  border: '1px solid var(--dsw-alias-border, #444)',
  borderRadius: 7,
  color: 'var(--dsw-alias-label-primary, #eee)',
  cursor: 'pointer',
  display: 'inline-flex',
  fontSize: 12,
  fontWeight: 600,
  height: 28,
  padding: '0 10px',
  whiteSpace: 'nowrap',
}

export function BlaxelComposerAction(props: BlaxelComposerActionProps): ReactNode {
  const cwd = props.useSessions(state => state.byId[props.session.sessionId]?.cwd)
  const [phase, setPhase] = useState<Phase>('checking')
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState<string | undefined>()

  useEffect(() => {
    let current = true
    setPhase('checking')
    setReason(undefined)
    void (async () => {
      try {
        const status = await getStatus()
        if (!current) return
        if (status.mode === 'blaxel') {
          setPhase('active')
          return
        }
        if (cwd === undefined) {
          setPhase('ineligible')
          setReason('Choose a workspace inside a Git repository first')
          return
        }
        await checkWorkspace(cwd)
        if (current) setPhase('eligible')
      } catch (error) {
        if (!current) return
        setPhase('ineligible')
        setReason(error instanceof Error ? error.message : String(error))
      }
    })()
    return () => { current = false }
  }, [cwd])

  const open = async (): Promise<void> => {
    if (busy || phase !== 'eligible' || cwd === undefined || props.session.running) return
    setBusy(true)
    setReason(undefined)
    const target = window.open('about:blank', '_blank')
    try {
      const response = await openWorkspace(cwd)
      if (target === null) window.location.assign(response.url)
      else target.location.replace(response.url)
    } catch (error) {
      target?.close()
      setReason(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const disabled = phase !== 'eligible' || busy || props.session.running
  const title = phase === 'active'
    ? 'This DSH session is already running in Blaxel'
    : props.session.running
      ? 'Wait for the current turn to finish before snapshotting the repository'
      : reason ?? (phase === 'checking' ? 'Checking Git repository' : 'Open this Git worktree in a separate Blaxel session')

  return <button
    type="button"
    aria-label="Open current Git repository in Blaxel"
    disabled={disabled}
    onClick={() => { void open() }}
    style={{ ...actionButton, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.55 : 1 }}
    title={title}
  >
    {phase === 'active' ? 'Blaxel active' : busy ? 'Opening…' : 'Open in Blaxel'}
  </button>
}
