import { launching } from './launch-steps.js'
import { BlaxelChangeReview } from './BlaxelChangeReview.js'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { openCloudSession, reviewCloudChanges, closeBlaxel, inspectBlaxelChanges, moveBlaxelChangesLocal, reconnectBlaxelSandbox, SandboxMissingError, type ReconnectOutcome } from './api.js'
import { SandboxIcon } from './BlaxelSidebarMarker.js'
import { useBlaxelConfirmation, type ConfirmBlaxelAction } from './BlaxelConfirmDialog.js'
import { refreshBlaxelStatus, useBlaxelStatus } from './useBlaxelStatus.js'

const CHAT_ATTRIBUTE = 'data-blaxel-sandbox-chat'
const CHAT_STATE_ATTRIBUTE = 'data-blaxel-sandbox-state'
export const SESSION_PANE_SELECTOR = '[data-slot="conversation"]'
export const SANDBOX_SURFACE_BACKGROUND = 'var(--dsw-alias-bg-base, #151517)'

type SandboxState = 'creating' | 'restoring' | 'ready' | 'failed'
type BannerAction = 'reconnect' | 'local' | 'discard' | 'open'

export function recreateConfirmation(): string {
  return 'The Blaxel sandbox for this session no longer exists, so changes made only inside it cannot be recovered. '
    + 'Start a fresh sandbox from your current local files and keep this conversation? '
    + 'Choose Cancel to leave the session as it is; use Continue locally to drop the sandbox instead.'
}

export function continueLocallyConfirmation(): string {
  return 'Continue this session locally? The unavailable sandbox will be dropped and any changes that exist only inside it will be permanently lost.'
}

export function reconnectNotice(outcome: ReconnectOutcome): string {
  return outcome === 'recreated'
    ? 'A fresh sandbox was created from your local files. Changes from the previous sandbox were not recovered.'
    : 'Sandbox reconnected with its existing files. Newer local edits were not uploaded.'
}

/**
 * Reconnects, and only replaces a sandbox that is confirmed gone after the user
 * agrees. `cancelled` means nothing changed.
 */
export async function reconnectWithConsent(sessionId: string, confirm: ConfirmBlaxelAction): Promise<ReconnectOutcome | 'cancelled'> {
  try {
    return await reconnectBlaxelSandbox(sessionId)
  } catch (error) {
    if (!(error instanceof SandboxMissingError)) throw error
    if (!await confirm({ title: 'Start a fresh sandbox?', message: recreateConfirmation(), confirmLabel: 'Start fresh sandbox', danger: true })) return 'cancelled'
    return await reconnectBlaxelSandbox(sessionId, { recreate: true })
  }
}

export const SANDBOX_CHAT_CSS = `
[${CHAT_ATTRIBUTE}="true"] {
  position: relative;
}
[${CHAT_ATTRIBUTE}="true"]::after {
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #6da7ff) 28%, transparent);
  box-shadow: inset 0 0 72px color-mix(in srgb, var(--dsw-alias-state-business-primary, #6da7ff) 6%, transparent);
  content: '';
  inset: 0;
  pointer-events: none;
  position: absolute;
  z-index: 20;
}
[${CHAT_ATTRIBUTE}="true"][${CHAT_STATE_ATTRIBUTE}="failed"]::after {
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 58%, transparent);
  box-shadow: inset 0 0 90px color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 10%, transparent);
}
[data-blaxel-sandbox-link]:hover,
[data-blaxel-sandbox-action]:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #6da7ff) 14%, transparent) !important;
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #6da7ff) 48%, transparent) !important;
}
`

const surface: CSSProperties = {
  background: SANDBOX_SURFACE_BACKGROUND,
  boxSizing: 'border-box',
  flex: '0 0 auto',
  paddingTop: 8,
  position: 'relative',
  width: '100%',
  zIndex: 1,
}

const banner: CSSProperties = {
  background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #6da7ff) 7%, var(--dsw-alias-bg-base, #151517))',
  border: '1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #6da7ff) 24%, transparent)',
  borderRadius: 9,
  boxSizing: 'border-box',
  color: 'var(--dsw-alias-label-primary, currentColor)',
  display: 'flex',
  flexDirection: 'column',
  fontSize: 12,
  gap: 7,
  margin: '0 auto 8px',
  maxWidth: 780,
  minHeight: 38,
  padding: '8px 10px',
  width: 'calc(100% - 32px)',
}

const failedBanner: CSSProperties = {
  background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 12%, var(--dsw-alias-bg-base, #151517))',
  borderColor: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 58%, transparent)',
}

const modePill: CSSProperties = {
  border: '1px solid currentColor',
  borderRadius: 999,
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.08em',
  padding: '2px 6px',
  whiteSpace: 'nowrap',
}

const action: CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28))',
  borderRadius: 6,
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
  fontWeight: 600,
  padding: '5px 8px',
  whiteSpace: 'nowrap',
}

export interface BlaxelSandboxBannerProps {
  /** Standard DSH session-scope prop; the dock owner's `session` object is not relied on. */
  sessionId: string
  setUnavailableBlock(sessionId: string, unavailable: boolean): void
}

export interface SandboxPresentation {
  title: string
  detail: string
}

export function sandboxPresentation(state: SandboxState): SandboxPresentation {
  if (state === 'ready') return { title: 'Running on Blaxel', detail: 'Tools use sandbox files. Local edits stay local until you move back, merge, and reopen.' }
  if (state === 'failed') return { title: 'Sandbox unavailable', detail: 'Reconnect to resume its existing files. Newer local edits will not be uploaded.' }
  return { title: 'Connecting to Blaxel', detail: 'Local tools stay off while the remote workspace starts.' }
}

export function moveLocalConfirmation(changed: number): string {
  if (changed === 0) return 'Move this session back to local? No sandbox file changes were found. Your local edits will be kept. The sandbox will stop and the session will continue in its original worktree.'
  const files = changed === 1 ? '1 changed file' : `${String(changed)} changed files`
  return `Move this session back to local? ${files} will be applied to the original worktree, keeping compatible local edits, then the sandbox will stop. If any file conflicts, neither copy will change and the sandbox will stay available.`
}

/** Every return surface uses the same reviewed transaction. */
export async function reviewAndReturn(sessionId: string, cloud: boolean, confirm: ConfirmBlaxelAction): Promise<boolean> {
  if (cloud) {
    const review = await reviewCloudChanges(sessionId)
    if (!await confirm({ title: 'Bring your session back', message: 'Review the changes below. Your conversation will return with them. Compatible local edits are preserved, and the sandbox stops after a successful transfer.', confirmLabel: review.divergence.changed === 0 ? 'Move session back' : 'Apply changes and move back', details: <BlaxelChangeReview review={review} /> })) return false
    await moveBlaxelChangesLocal(sessionId, review.reviewHash)
    // Recreate native browser image handles and select the returned conversation,
    // including when return started from another session's Settings panel.
    const local = new URL('/', window.location.origin)
    local.searchParams.set('blaxel-local', sessionId)
    window.location.assign(local.href)
  } else {
    const divergence = await inspectBlaxelChanges(sessionId)
    if (!await confirm({ title: 'Move back to local?', message: moveLocalConfirmation(divergence.changed), confirmLabel: 'Move back to local' })) return false
    await moveBlaxelChangesLocal(sessionId)
  }
  return true
}

export function sandboxConsoleUrl(workspace: string, sandbox: string, environment: 'production' | 'development'): string {
  const host = environment === 'development' ? 'https://app.blaxel.dev' : 'https://app.blaxel.ai'
  return `${host}/${encodeURIComponent(workspace)}/global-agentic-network/sandbox/${encodeURIComponent(sandbox)}`
}

/** Finds the nearest native session pane without depending on hashed DSH classes. */
function sessionPane(element: HTMLElement): HTMLElement | undefined {
  return element.closest<HTMLElement>(SESSION_PANE_SELECTOR) ?? undefined
}

/** Sandbox identity, reconnect action, and a visual treatment on the native chat pane. */
export function BlaxelSandboxBanner(props: BlaxelSandboxBannerProps): ReactNode {
  const confirmation = useBlaxelConfirmation()
  const status = useBlaxelStatus()
  const item = status?.sandboxes.find(candidate => candidate.sessionId === props.sessionId)
  const element = useRef<HTMLElement | null>(null)
  const [busy, setBusy] = useState<BannerAction>()
  const [actionError, setActionError] = useState<string>()
  const [notice, setNotice] = useState<string>()

  useEffect(() => {
    if (item === undefined || element.current === null) return
    const pane = sessionPane(element.current)
    pane?.setAttribute(CHAT_ATTRIBUTE, 'true')
    pane?.setAttribute(CHAT_STATE_ATTRIBUTE, item.state)
    return () => {
      pane?.removeAttribute(CHAT_ATTRIBUTE)
      pane?.removeAttribute(CHAT_STATE_ATTRIBUTE)
    }
  }, [item?.state])

  const statusLoaded = status !== undefined
  useEffect(() => {
    if (!statusLoaded) return
    props.setUnavailableBlock(props.sessionId, item?.state === 'failed')
    return () => props.setUnavailableBlock(props.sessionId, false)
  }, [item?.state, props.sessionId, statusLoaded])

  const autoReview = useRef(false)
  useEffect(() => {
    if (item?.cloud === undefined || autoReview.current) return
    const url = new URL(window.location.href)
    if (url.searchParams.get('blaxel-return') !== props.sessionId) return
    autoReview.current = true
    url.searchParams.delete('blaxel-return')
    window.history.replaceState(null, '', url)
    void moveLocal()
  }, [item?.cloud, props.sessionId])

  if (item === undefined) return confirmation.dialog
  const failed = item.state === 'failed'
  const preparing = item.cloud?.phase === 'preparing' && launching(status)
  const presentation = item.cloud === undefined ? sandboxPresentation(item.state) : {
    title: item.cloud.phase === 'preparing' ? 'Preparing your cloud session' : item.cloud.phase === 'returning' ? 'Finishing the return to local' : 'This conversation is on Blaxel',
    detail: item.cloud.phase === 'preparing' ? 'Installing the agent runtime and restoring your conversation.' : 'Open the cloud session to continue, or review its changes and bring everything back.',
  }
  const tone = failed
    ? 'var(--dsw-alias-state-warn-label, #f59e0b)'
    : 'var(--dsw-alias-state-business-primary, #6da7ff)'

  const reconnect = async (): Promise<void> => {
    setBusy('reconnect')
    setActionError(undefined)
    setNotice(undefined)
    try {
      const outcome = await reconnectWithConsent(item.sessionId, confirmation.confirm)
      if (outcome === 'cancelled') return
      if (outcome === 'recreated') setNotice(reconnectNotice(outcome))
      refreshBlaxelStatus()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The sandbox could not be reconnected')
    } finally {
      setBusy(undefined)
    }
  }

  const continueLocally = async (): Promise<void> => {
    if (!await confirmation.confirm({ title: 'Continue locally?', message: continueLocallyConfirmation(), confirmLabel: 'Continue locally', danger: true })) return
    setBusy('discard')
    setActionError(undefined)
    setNotice(undefined)
    try {
      await closeBlaxel(item.sessionId)
      refreshBlaxelStatus()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The sandbox could not be dropped')
    } finally {
      setBusy(undefined)
    }
  }

  const moveLocal = async (): Promise<void> => {
    setBusy('local')
    setActionError(undefined)
    try {
      if (!await reviewAndReturn(item.sessionId, item.cloud !== undefined, confirmation.confirm)) return
      refreshBlaxelStatus()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The session could not be moved back to local')
    } finally {
      setBusy(undefined)
    }
  }

  const openCloud = async (): Promise<void> => {
    setBusy('open')
    setActionError(undefined)
    try { window.location.assign(await openCloudSession(item.sessionId)) }
    catch (error) { setActionError(error instanceof Error ? error.message : 'Could not open the cloud session') }
    finally { setBusy(undefined) }
  }

  const identity = <>
    <span style={{ color: tone, display: 'inline-flex', marginTop: 2 }}><SandboxIcon size={16} /></span>
    <span style={{ ...modePill, color: tone, marginTop: 1 }}>SANDBOXED</span>
    <span style={{ display: 'flex', flex: '1 1 260px', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <strong style={{ fontWeight: 650 }}>{presentation.title}</strong>
      <span style={{ color: failed ? tone : 'var(--dsw-alias-label-secondary, #aaa)', overflowWrap: 'anywhere' }}>{presentation.detail}</span>
    </span>
  </>

  const content = failed ? <>
    <div style={{ alignItems: 'flex-start', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {identity}
      <button data-blaxel-sandbox-action="true" disabled={busy !== undefined} style={action} type="button" onClick={() => void reconnect()}>{busy === 'reconnect' ? 'Reconnecting…' : 'Reconnect to sandbox'}</button>
      <button data-blaxel-sandbox-action="true" disabled={busy !== undefined} style={action} title="Drop the unavailable sandbox and continue this session locally" type="button" onClick={() => void continueLocally()}>{busy === 'discard' ? 'Dropping sandbox…' : 'Continue locally'}</button>
    </div>
    {actionError === undefined ? null : <div role="alert" style={{ color: tone, overflowWrap: 'anywhere', paddingLeft: 24 }}>{actionError}</div>}
  </> : <div style={{ alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
    {item.state === 'ready' ? <a aria-label="Open this sandbox in Blaxel" data-blaxel-sandbox-link="true" href={sandboxConsoleUrl(item.workspace, item.sandbox.name, item.environment)} rel="noreferrer" style={{ alignItems: 'flex-start', color: 'inherit', display: 'flex', flex: '1 1 360px', gap: 8, minWidth: 0, textDecoration: 'none' }} target="_blank" title="Open this sandbox in Blaxel">{identity}</a> : identity}
    {item.cloud !== undefined && <button type="button" style={action} disabled={busy !== undefined || preparing} onClick={() => { void openCloud() }}>{preparing ? 'Preparing…' : busy === 'open' ? 'Opening…' : item.cloud.phase === 'preparing' ? 'Retry cloud setup' : 'Open cloud session'}</button>}
    {item.state === 'ready' ? <button data-blaxel-sandbox-action="true" disabled={busy !== undefined || preparing || item.live.processes > 0} style={action} title={item.live.processes > 0 ? 'Wait for active sandbox tools to finish' : undefined} type="button" onClick={() => void moveLocal()}>{busy === 'local' ? 'Checking changes…' : 'Move back to local'}</button> : null}
    {actionError === undefined ? null : <div role="alert" style={{ color: tone, flexBasis: '100%', overflowWrap: 'anywhere' }}>{actionError}</div>}
    {notice === undefined ? null : <div role="status" style={{ color: 'var(--dsw-alias-label-secondary, #aaa)', flexBasis: '100%', overflowWrap: 'anywhere' }}>{notice}</div>}
  </div>

  return <>
    {confirmation.dialog}
    <style>{SANDBOX_CHAT_CSS}</style>
    <div data-blaxel-sandbox-surface="true" ref={node => { element.current = node }} style={surface}>
      <div aria-live="polite" data-state={item.state} style={{ ...banner, ...(failed ? failedBanner : {}) }}>{content}</div>
    </div>
  </>
}
