import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'

export interface BlaxelConfirmation {
  title: string
  message: string
  confirmLabel: string
  danger?: boolean
  details?: ReactNode
}

export type ConfirmBlaxelAction = (request: BlaxelConfirmation) => boolean | Promise<boolean>

const button: CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--dsw-alias-border-l2, #555)',
  borderRadius: 7,
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
  fontWeight: 600,
  padding: '8px 12px',
}

function BlaxelConfirmDialog(props: { request: BlaxelConfirmation; onClose: (confirmed: boolean) => void }): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const accept = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const messageId = useId()

  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => { element?.close() }
  }, [])

  return <dialog
    ref={dialog}
    data-blaxel-confirmation
    aria-labelledby={titleId}
    aria-describedby={messageId}
    onCancel={event => { event.preventDefault(); props.onClose(false) }}
    onKeyDown={event => {
      if (event.key === 'Escape') event.stopPropagation()

    }}
    style={{ background: 'var(--dsw-alias-bg-layer-1, #1f1f1f)', border: '1px solid var(--dsw-alias-border-l2, #444)', borderRadius: 12, boxShadow: '0 16px 64px #0006', color: 'var(--dsw-alias-label-primary, #eee)', fontSize: 13, lineHeight: 1.6, margin: 'auto', maxWidth: 'calc(100vw - 32px)', padding: 24, width: props.request.details === undefined ? 460 : 880, maxHeight: '85vh', overflowY: 'auto' }}
  >
    <style>{'[data-blaxel-confirmation]::backdrop { background: #0008; }'}</style>
    <h2 id={titleId} style={{ fontSize: 17, lineHeight: 1.4, margin: '0 0 12px' }}>{props.request.title}</h2>
    <p id={messageId} style={{ color: 'var(--dsw-alias-label-secondary, #aaa)', margin: '0 0 24px' }}>{props.request.message}</p>
    {props.request.details}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }}>
      <button ref={cancel} autoFocus type="button" style={button} onClick={() => props.onClose(false)}>Cancel</button>
      <button ref={accept} type="button" style={{ ...button, background: props.request.danger === true ? 'transparent' : 'var(--dsw-alias-button-primary-fill, #316fea)', color: props.request.danger === true ? 'var(--dsw-alias-state-error-primary, #ec1313)' : 'var(--dsw-alias-label-primary-foreground, #fff)' }} onClick={() => props.onClose(true)}>{props.request.confirmLabel}</button>
    </div>
  </dialog>
}

/** Cancelling or leaving the component never authorizes a pending action. */
export function useBlaxelConfirmation(): { confirm: ConfirmBlaxelAction; dialog: ReactNode } {
  const [request, setRequest] = useState<BlaxelConfirmation>()
  const resolve = useRef<((confirmed: boolean) => void) | undefined>(undefined)
  const trigger = useRef<HTMLElement | undefined>(undefined)
  const finish = useCallback((confirmed: boolean) => {
    const pending = resolve.current
    resolve.current = undefined
    setRequest(undefined)
    pending?.(confirmed)
    const opener = trigger.current
    requestAnimationFrame(() => { if (opener?.isConnected === true) opener.focus() })
  }, [])

  useEffect(() => () => {
    resolve.current?.(false)
    resolve.current = undefined
  }, [])

  const confirm = useCallback((next: BlaxelConfirmation): Promise<boolean> => {
    if (resolve.current !== undefined) return Promise.resolve(false)
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    return new Promise<boolean>(done => {
      resolve.current = done
      setRequest(next)
    })
  }, [])

  return { confirm, dialog: request === undefined ? null : <BlaxelConfirmDialog request={request} onClose={finish} /> }
}
