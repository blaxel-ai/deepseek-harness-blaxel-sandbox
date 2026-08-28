import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { ModelReadiness } from '../shared/model-readiness.js'
import { modelReadinessMessage } from '../shared/model-readiness.js'
import {
  checkWorkspace, getModelReadiness, moveSession, openWorkspace, saveModelCredential, type LaunchProgress,
} from './api.js'
import { BlaxelLaunchPanel } from './BlaxelLaunchPanel.js'
import { BlaxelModelReadinessPanel } from './BlaxelModelReadinessPanel.js'
import type { ClientSessionListState } from './context.js'
import { refreshBlaxelStatus, useBlaxelStatus } from './useBlaxelStatus.js'

export interface BlaxelComposerActionProps {
  session: { sessionId: string; running: boolean }
  useSessions: <T>(selector: (state: ClientSessionListState) => T) => T
  openSession: (sessionId: string) => void
  setComposerBlock: (sessionId: string, reason?: string) => void
}

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
  const summary = props.useSessions(state => state.byId[props.session.sessionId])
  const status = useBlaxelStatus()
  const [eligible, setEligible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<LaunchProgress | undefined>()
  const [reason, setReason] = useState<string | undefined>()
  const [readiness, setReadiness] = useState<ModelReadiness | undefined>()
  const [repairOpen, setRepairOpen] = useState(false)
  const sandboxed = status?.sandboxes.some(item => item.sessionId === props.session.sessionId) === true

  useEffect(() => {
    let current = true
    setEligible(false)
    setReason(undefined)
    if (sandboxed || summary?.cwd === undefined) return
    void checkWorkspace(summary.cwd).then(() => {
      if (current) setEligible(true)
    }).catch((error: unknown) => {
      if (current) setReason(error instanceof Error ? error.message : String(error))
    })
    return () => { current = false }
  }, [sandboxed, summary?.cwd])

  const progress = status?.progress
  const lastProgress = useRef<LaunchProgress | undefined>(undefined)
  useEffect(() => {
    if (progress !== undefined) lastProgress.current = progress
  }, [progress])

  useEffect(() => {
    if (!sandboxed) return
    let current = true
    const check = async (): Promise<void> => {
      const next = await getModelReadiness(props.session.sessionId).catch((error: unknown): ModelReadiness => ({
        kind: 'verification-failed',
        message: error instanceof Error ? error.message : String(error),
      }))
      if (current) setReadiness(next)
    }
    void check()
    const timer = setInterval(() => { void check() }, 15_000)
    return () => {
      current = false
      clearInterval(timer)
    }
  }, [props.session.sessionId, sandboxed])

  useEffect(() => {
    const block = sandboxed && readiness !== undefined && readiness.kind !== 'ready'
      ? modelReadinessMessage(readiness)
      : undefined
    props.setComposerBlock(props.session.sessionId, block)
    return () => { props.setComposerBlock(props.session.sessionId) }
  }, [props.session.sessionId, props.setComposerBlock, readiness, sandboxed])

  const performLaunch = async (): Promise<void> => {
    if (summary?.cwd === undefined) return
    const now = new Date().toISOString()
    const kind = summary.blank ? 'open' : 'move'
    setReason(undefined)
    setPending({ kind, step: 'inspecting', startedAt: now, updatedAt: now })
    refreshBlaxelStatus()
    try {
      const result = summary.blank
        ? await openWorkspace(summary.cwd, props.session.sessionId, summary.displayTitle)
        : await moveSession(summary.cwd, props.session.sessionId, summary.displayTitle)
      refreshBlaxelStatus()
      setPending(undefined)
      if (result.sessionId !== props.session.sessionId) props.openSession(result.sessionId)
    } catch (error) {
      const next = await getModelReadiness(props.session.sessionId).catch(() => undefined)
      if (next !== undefined && next.kind !== 'ready') {
        setReadiness(next)
        setRepairOpen(true)
        setPending(undefined)
        return
      }
      setReason(error instanceof Error ? error.message : String(error))
      setPending(current => lastProgress.current ?? current)
    }
  }

  const launch = async (): Promise<void> => {
    if (busy || !eligible || summary?.cwd === undefined || props.session.running) return
    setBusy(true)
    setReason(undefined)
    try {
      const next = await getModelReadiness(props.session.sessionId)
      setReadiness(next)
      if (next.kind !== 'ready') {
        setRepairOpen(true)
        return
      }
      await performLaunch()
    } catch (error) {
      setReason(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const retryReadiness = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setReason(undefined)
    try {
      const next = await getModelReadiness(props.session.sessionId)
      setReadiness(next)
      if (next.kind !== 'ready') return
      setRepairOpen(false)
      if (!sandboxed) await performLaunch()
    } catch (error) {
      setReason(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const configureCredential = async (credential: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    setReason(undefined)
    try {
      const next = await saveModelCredential(props.session.sessionId, credential)
      setReadiness(next)
      setRepairOpen(false)
      if (!sandboxed) await performLaunch()
    } catch (error) {
      setReason(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const shown = pending === undefined ? undefined : progress ?? pending
  const panel = shown === undefined ? null : <BlaxelLaunchPanel
    progress={shown}
    {...(reason === undefined ? {} : { error: reason })}
    onDismiss={() => setPending(undefined)}
  />

  const repair = readiness === undefined || readiness.kind === 'ready' || !repairOpen ? null : <BlaxelModelReadinessPanel
    readiness={readiness}
    busy={busy}
    {...(reason === undefined ? {} : { error: reason })}
    onSave={credential => { void configureCredential(credential) }}
    onRetry={() => { void retryReadiness() }}
    onDismiss={() => { setRepairOpen(false); setReason(undefined) }}
  />

  if (sandboxed) {
    if (readiness === undefined || readiness.kind === 'ready') return panel
    const label = readiness.kind === 'credential-missing' ? `Connect ${readiness.providerName}` : 'Fix model'
    return <>
      {panel}
      {repair}
      <button type="button" style={actionButton} disabled={busy} onClick={() => { setRepairOpen(true) }}>
        {busy ? 'Checking…' : label}
      </button>
    </>
  }

  const disabled = !eligible || busy || props.session.running
  const title = props.session.running
    ? 'Wait for the current turn to finish before creating a sandbox session'
    : reason ?? (summary?.blank
      ? 'Create a sandbox-backed session for this Git worktree'
      : 'Move this session onto a Blaxel sandbox')

  return <>
    {panel}
    {repair}
    <button
      type="button"
      aria-label={summary?.blank ? 'Open current Git repository in a sandbox session' : 'Move this session to a sandbox'}
      disabled={disabled}
      onClick={() => { void launch() }}
      style={{ ...actionButton, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.55 : 1 }}
      title={title}
    >
      {busy ? 'Checking…' : summary?.blank ? 'Open in Sandbox' : 'Move to Sandbox'}
    </button>
  </>
}
