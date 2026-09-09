import { useEffect, useMemo, type ReactNode } from 'react'
import type { ClientSessionListState } from './context.js'
import { useBlaxelStatus } from './useBlaxelStatus.js'

const ATTRIBUTE = 'data-blaxel-sandbox-session'
const STYLE_ID = 'blaxel-sandbox-sidebar-marker'
const CONTAINER_MASK = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.35' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M2.5 5h11v8h-11V5Z'/%3E%3Cpath d='M1.5 3h13v2h-13V3Z'/%3E%3Cpath d='M6 8.5h4'/%3E%3C/svg%3E")`

/** Uses DSH's native leading icon slot instead of competing with row pseudo-elements. */
export const SIDEBAR_MARKER_CSS = `
[role="treeitem"][${ATTRIBUTE}] > span:first-child {
  align-self: center;
  background-color: currentColor;
  color: var(--dsw-alias-state-business-primary, #6da7ff);
  flex: 0 0 14px;
  height: 14px;
  margin-left: 8px;
  margin-right: 2px;
  -webkit-mask: ${CONTAINER_MASK} center / contain no-repeat;
  mask: ${CONTAINER_MASK} center / contain no-repeat;
  width: 14px;
}
[role="treeitem"][${ATTRIBUTE}="failed"] > span:first-child {
  color: var(--dsw-alias-state-warn-primary, #f59e0b);
  filter: drop-shadow(0 0 3px color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 72%, transparent));
}
`

export interface BlaxelSidebarMarkerProps {
  useSessions: <T>(selector: (state: ClientSessionListState) => T) => T
}

/** Titles that identify live sandbox rows without changing DSH's persisted title. */
export function sandboxRowTitles(state: ClientSessionListState, sandboxIds: readonly string[]): string[] {
  const counts = new Map<string, number>()
  for (const session of Object.values(state.byId)) {
    const title = session?.blank === false ? session.displayTitle?.trim() : undefined
    if (title !== undefined && title !== '') counts.set(title, (counts.get(title) ?? 0) + 1)
  }

  const titles = new Set<string>()
  for (const sessionId of sandboxIds) {
    const session = state.byId[sessionId]
    if (session === undefined) continue
    if (session.blank) {
      if (state.current === sessionId) titles.add('New Session')
      continue
    }
    const title = session.displayTitle?.trim()
    if (title !== undefined && title !== '' && (state.current === sessionId || counts.get(title) === 1)) titles.add(title)
  }
  return [...titles].sort((left, right) => right.length - left.length)
}

export function SandboxIcon(props: { size?: number } = {}): ReactNode {
  const size = props.size ?? 16
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 16 16" fill="none">
    <path d="M2.5 5h11v8h-11V5Z" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
    <path d="M1.5 3h13v2h-13V3Z" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
    <path d="M6 8.5h4" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
  </svg>
}

/** Adds a visual-only container marker while leaving native session naming untouched. */
export function BlaxelSidebarMarker(props: BlaxelSidebarMarkerProps): ReactNode {
  const sessions = props.useSessions(state => state)
  const status = useBlaxelStatus()
  const sandboxIds = useMemo(() => status?.sandboxes.map(item => item.sessionId) ?? [], [status])
  const failedIds = useMemo(() => status?.sandboxes.filter(item => item.state === 'failed').map(item => item.sessionId) ?? [], [status])
  const startingIds = useMemo(() => status?.sandboxes.filter(item => item.state === 'creating' || item.state === 'restoring').map(item => item.sessionId) ?? [], [status])
  const titles = useMemo(() => sandboxRowTitles(sessions, sandboxIds), [sessions, sandboxIds])
  const failedTitles = useMemo(() => sandboxRowTitles(sessions, failedIds), [sessions, failedIds])
  const startingTitles = useMemo(() => sandboxRowTitles(sessions, startingIds), [sessions, startingIds])

  useEffect(() => {
    let style = document.getElementById(STYLE_ID)
    if (style === null) {
      style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = SIDEBAR_MARKER_CSS
      document.head.append(style)
    }

    const decorate = (): void => {
      document.querySelectorAll<HTMLElement>(`[${ATTRIBUTE}]`).forEach(row => row.removeAttribute(ATTRIBUTE))
      document.querySelectorAll<HTMLElement>('[role="treeitem"]').forEach(row => {
        if (row.hasAttribute('aria-expanded')) return
        const text = row.textContent?.trim() ?? ''
        const state = failedTitles.some(title => text.startsWith(title))
          ? 'failed'
          : startingTitles.some(title => text.startsWith(title))
            ? 'restoring'
            : titles.some(title => text.startsWith(title)) ? 'ready' : undefined
        if (state !== undefined) row.setAttribute(ATTRIBUTE, state)
      })
    }

    decorate()
    const observer = new MutationObserver(decorate)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      document.querySelectorAll<HTMLElement>(`[${ATTRIBUTE}]`).forEach(row => row.removeAttribute(ATTRIBUTE))
    }
  }, [failedTitles, startingTitles, titles])

  return null
}
