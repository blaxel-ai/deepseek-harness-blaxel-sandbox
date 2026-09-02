import { useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import type { ModelReadiness } from '../shared/model-readiness.js'
import { modelReadinessMessage } from '../shared/model-readiness.js'

interface Props {
  readiness: Exclude<ModelReadiness, { kind: 'ready' }>
  busy: boolean
  error?: string
  onSave: (credential: string) => void
  onRetry: () => void
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

const control: CSSProperties = {
  background: 'var(--dsw-alias-bg-input, #171717)',
  border: '1px solid var(--dsw-alias-border, #444)',
  borderRadius: 7,
  boxSizing: 'border-box',
  color: 'var(--dsw-alias-label-primary, #eee)',
  font: 'inherit',
  height: 32,
  padding: '0 9px',
  width: '100%',
}

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

export function BlaxelModelReadinessPanel(props: Props): ReactNode {
  const [credential, setCredential] = useState('')
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (credential.trim() !== '' && !props.busy) props.onSave(credential)
  }

  return <section aria-label="Model setup required" style={panel}>
    <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>
      {props.readiness.kind === 'credential-missing' ? `Connect ${props.readiness.providerName}` : 'Model setup required'}
    </h3>
    <p style={{ color: 'var(--dsw-alias-label-secondary, #aaa)', lineHeight: 1.45, margin: '0 0 10px' }}>
      {modelReadinessMessage(props.readiness)}
    </p>
    {props.readiness.kind === 'credential-missing' && props.readiness.writable ? <form onSubmit={submit}>
      <label style={{ display: 'block', marginBottom: 5 }} htmlFor="blaxel-model-credential">
        {props.readiness.providerName} API key
      </label>
      <input
        id="blaxel-model-credential"
        type="password"
        autoComplete="off"
        spellCheck={false}
        disabled={props.busy}
        value={credential}
        onChange={event => { setCredential(event.target.value) }}
        style={control}
      />
      <p style={{ color: 'var(--dsw-alias-label-tertiary, #777)', lineHeight: 1.4, margin: '7px 0 10px' }}>
        Saved on this computer and never copied into the sandbox.
      </p>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" style={button} disabled={props.busy} onClick={props.onDismiss}>Cancel</button>
        <button type="submit" style={button} disabled={props.busy || credential.trim() === ''}>
          {props.busy ? 'Saving…' : 'Save and continue'}
        </button>
      </div>
    </form> : <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
      <button type="button" style={button} disabled={props.busy} onClick={props.onDismiss}>Close</button>
      <button type="button" style={button} disabled={props.busy} onClick={props.onRetry}>
        {props.busy ? 'Checking…' : 'Retry'}
      </button>
    </div>}
    {props.error === undefined ? null : <p role="alert" style={{ color: '#ff6961', margin: '10px 0 0' }}>{props.error}</p>}
  </section>
}
