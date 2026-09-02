import type { CSSProperties, ReactNode } from 'react'
import type { LaunchProgress } from './api.js'
import { launchLines, type LaunchLine } from './launch-steps.js'

interface BlaxelLaunchPanelProps {
  progress: LaunchProgress
  error?: string
  onDismiss: () => void
}

const panel: CSSProperties = {
  background: 'var(--dsw-alias-bg-layer-1, #1f1f1f)',
  border: '1px solid var(--dsw-alias-border, #333)',
  borderRadius: 12,
  bottom: 96,
  boxShadow: '0 8px 32px rgba(0, 0, 0, 0.32)',
  color: 'var(--dsw-alias-label-primary, #eee)',
  fontSize: 12,
  maxWidth: 'calc(100vw - 32px)',
  padding: 14,
  position: 'fixed',
  right: 16,
  width: 340,
  zIndex: 40,
}

const head: CSSProperties = {
  alignItems: 'baseline',
  display: 'flex',
  gap: 8,
  fontWeight: 600,
  marginBottom: 10,
}

const line: CSSProperties = { alignItems: 'baseline', display: 'flex', gap: 8, padding: '3px 0' }
const muted: CSSProperties = { color: 'var(--dsw-alias-label-secondary, #aaa)' }

const button: CSSProperties = {
  background: 'var(--dsw-alias-bg-button, transparent)',
  border: '1px solid var(--dsw-alias-border, #444)',
  borderRadius: 7,
  color: 'var(--dsw-alias-label-primary, #eee)',
  cursor: 'pointer',
  font: 'inherit',
  fontWeight: 600,
  height: 28,
  padding: '0 10px',
}

/** Left gutter: a filled dot for finished work, a ring for the step in flight. */
function Marker(props: { state: LaunchLine['state'] }): ReactNode {
  const done = props.state === 'done'
  return <span aria-hidden="true" style={{
    background: done ? '#34c759' : 'transparent',
    border: done ? 0 : `1px solid ${props.state === 'active' ? '#5ac8fa' : 'var(--dsw-alias-label-tertiary, #666)'}`,
    borderRadius: 999,
    boxSizing: 'border-box',
    display: 'inline-block',
    flex: 'none',
    height: 8,
    marginTop: 4,
    width: 8,
  }} />
}

/**
 * The launch, shown where it was started. Every line is a step the host is
 * really performing, so the wait is accounted for rather than hidden behind a
 * blank page. The caller opens the native session as soon as it is ready.
 */
export function BlaxelLaunchPanel(props: BlaxelLaunchPanelProps): ReactNode {
  const lines = launchLines(props.progress)
  const done = props.progress.step === 'ready'
  return <section aria-label="Sandbox launch progress" style={panel}>
    <div style={head}>
      <span>{props.progress.kind === 'move' ? 'Moving this session to Blaxel' : 'Opening this repository on Blaxel'}</span>
    </div>
    <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {lines.map(entry => <li key={entry.step} style={{ ...line, opacity: entry.state === 'waiting' ? 0.5 : 1 }}>
        <Marker state={entry.state} />
        <span style={{ flex: 1 }}>
          {entry.label}
          {entry.detail === undefined ? null : <><br /><span style={muted}>{entry.detail}</span></>}
        </span>
      </li>)}
    </ol>
    {props.error === undefined ? null : <p role="alert" style={{ color: '#ff6961', margin: '10px 0 0' }}>{props.error}</p>}
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
      <button type="button" style={button} onClick={props.onDismiss}>{done || props.error !== undefined ? 'Close' : 'Hide'}</button>
    </div>
  </section>
}
