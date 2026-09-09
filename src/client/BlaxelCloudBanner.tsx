import { flushSessionDraft, useSessionDraft } from './useSessionDraft.js'
import { useEffect, useState, type ReactNode } from 'react'
import { getCloudAccessLink, getRuntimeMode, type RuntimeMode } from './api.js'
import type { ClientConversation, SessionSlotProps } from './context.js'
import { SandboxIcon } from './BlaxelSidebarMarker.js'

export function BlaxelCloudBanner(props: SessionSlotProps & { conversation: ClientConversation; mode: Extract<RuntimeMode, { mode: 'cloud' }> }): ReactNode {
  const running = props.useSession(snapshot => snapshot.running)
  const [held, setHeld] = useState(props.mode.held)
  const draftError = useSessionDraft(props, props.conversation, !held)
  const [copyState, setCopyState] = useState('Copy private link')
  const [copyError, setCopyError] = useState<string>()
  const copyLink = async (): Promise<void> => {
    setCopyError(undefined)
    try { await navigator.clipboard.writeText(await getCloudAccessLink()); setCopyState('Private link copied') }
    catch (error) { setCopyError(error instanceof Error ? error.message : 'Could not copy the private link') }
  }
  useEffect(() => {
    const timer = setInterval(() => {
      void getRuntimeMode().then(mode => { if (mode.mode === 'cloud') setHeld(mode.held) }).catch(() => undefined)
    }, 5000)
    return () => clearInterval(timer)
  }, [])
  const back = new URL('/blaxel/return', props.mode.localOrigin)
  back.searchParams.set('sessionId', props.mode.sessionId)
  return <section aria-label="Cloud session" style={{ border: '1px solid #6acda74d', background: '#6acda70b', borderRadius: 10, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, margin: '0 auto 10px', padding: '12px 14px', maxWidth: 780 }}>
    <span style={{ color: 'color-mix(in srgb, var(--dsw-alias-label-primary, #eee) 65%, #22c55e)', display: 'flex' }}><SandboxIcon size={20} /></span>
    <div style={{ flex: '1 1 240px' }}>
      <strong style={{ display: 'block', fontSize: 13 }}>{held ? 'Ready to return to your computer' : running ? 'Your agent is working on Blaxel' : 'Your session is on Blaxel'}</strong>
      <span style={{ color: 'var(--dsw-alias-label-secondary, #aaa)', fontSize: 12 }}>{held ? 'The cloud session is paused while its changes are transferred.' : 'You can close your laptop. The session runs independently here.'}</span>
    </div>
    <button type="button" onClick={() => { void copyLink() }} title="Private access for another device. Anyone with this link can access your session until it expires." style={{ background: 'transparent', border: '1px solid var(--dsw-alias-border-l2, #6acda765)', borderRadius: 7, color: 'var(--dsw-alias-label-primary, #eee)', cursor: 'pointer', fontSize: 12, fontWeight: 600, padding: '7px 10px' }}>{copyState}</button>
    {draftError !== undefined && <span role="status">{draftError}</span>}
    {copyError !== undefined && <span role="alert">{copyError}</span>}
    <a href={back.href} onClick={event => { event.preventDefault(); if (held) { window.location.assign(back.href); return } void flushSessionDraft(props.sessionId).then(() => window.location.assign(back.href)).catch(error => setCopyError(error instanceof Error ? error.message : 'Draft not saved')) }} title="Open on the original computer with DeepSeek Harness running to review and apply changes" style={{ border: '1px solid var(--dsw-alias-border-l2, #6acda765)', borderRadius: 7, color: 'var(--dsw-alias-label-primary, #eee)', fontSize: 12, fontWeight: 600, padding: '7px 10px', textDecoration: 'none' }}>Move back to local</a>
  </section>
}
