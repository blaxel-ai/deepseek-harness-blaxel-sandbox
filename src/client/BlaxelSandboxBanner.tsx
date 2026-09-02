import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { SandboxIcon } from './BlaxelSidebarMarker.js'
import { useBlaxelStatus } from './useBlaxelStatus.js'

const CHAT_ATTRIBUTE = 'data-blaxel-sandbox-chat'

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
[data-blaxel-sandbox-link]:hover {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #6da7ff) 12%, transparent) !important;
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #6da7ff) 42%, transparent) !important;
}
`

const banner: CSSProperties = {
  alignItems: 'center',
  background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #6da7ff) 7%, transparent)',
  border: '1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #6da7ff) 24%, transparent)',
  borderRadius: 9,
  color: 'var(--dsw-alias-label-primary, currentColor)',
  display: 'flex',
  fontSize: 12,
  gap: 8,
  margin: '0 auto 8px',
  maxWidth: 780,
  minHeight: 30,
  padding: '0 10px',
  textDecoration: 'none',
  transition: 'background 120ms ease, border-color 120ms ease',
  width: 'calc(100% - 32px)',
}

export interface BlaxelSandboxBannerProps {
  session: { sessionId: string }
}

export function sandboxConsoleUrl(workspace: string, sandbox: string, environment: 'production' | 'development'): string {
  const host = environment === 'development' ? 'https://app.blaxel.dev' : 'https://app.blaxel.ai'
  return `${host}/${encodeURIComponent(workspace)}/global-agentic-network/sandbox/${encodeURIComponent(sandbox)}`
}

function stateLabel(state: 'creating' | 'restoring' | 'ready' | 'failed'): string {
  if (state === 'ready') return 'Running on Blaxel'
  if (state === 'failed') return 'Blaxel sandbox unavailable'
  return 'Starting on Blaxel'
}

/** Finds the nearest native session pane without depending on hashed DSH classes. */
function sessionPane(element: HTMLElement): HTMLElement | undefined {
  let current = element.parentElement
  while (current !== null && current !== document.body) {
    if (current.querySelector('[role="tablist"]') !== null && current.querySelector('textarea') !== null) return current
    current = current.parentElement
  }
  return undefined
}

/** Sandbox identity above the composer plus a visual treatment on its native chat pane. */
export function BlaxelSandboxBanner(props: BlaxelSandboxBannerProps): ReactNode {
  const status = useBlaxelStatus()
  const item = status?.sandboxes.find(candidate => candidate.sessionId === props.session.sessionId)
  const element = useRef<HTMLAnchorElement>(null)

  useEffect(() => {
    if (item === undefined || element.current === null) return
    const pane = sessionPane(element.current)
    pane?.setAttribute(CHAT_ATTRIBUTE, 'true')
    return () => { pane?.removeAttribute(CHAT_ATTRIBUTE) }
  }, [item])

  if (item === undefined) return null
  const url = sandboxConsoleUrl(item.workspace, item.sandbox.name, item.environment)
  return <>
    <style>{SANDBOX_CHAT_CSS}</style>
    <a
      aria-label={`Open sandbox ${item.sandbox.name} in Blaxel`}
      data-blaxel-sandbox-link="true"
      href={url}
      ref={element}
      rel="noreferrer"
      style={banner}
      target="_blank"
      title="Open this sandbox in Blaxel"
    >
      <span style={{ color: 'var(--dsw-alias-state-business-primary, #6da7ff)', display: 'inline-flex' }}><SandboxIcon size={14} /></span>
      <strong style={{ fontWeight: 600 }}>{stateLabel(item.state)}</strong>
      <span aria-hidden="true" style={{ marginLeft: 'auto', opacity: 0.72 }}>Open in Blaxel&nbsp; ↗</span>
    </a>
  </>
}
