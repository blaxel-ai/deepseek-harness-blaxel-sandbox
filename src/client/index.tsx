import { getRuntimeMode } from './api.js'
import { BlaxelCloudBanner } from './BlaxelCloudBanner.js'
import type { SessionSlotProps } from './context.js'
import type { BlaxelClientContext } from './context.js'
import { BlaxelComposerAction, type BlaxelComposerActionProps } from './BlaxelComposerAction.js'
import { BlaxelSandboxBanner } from './BlaxelSandboxBanner.js'
import { BlaxelSidebarMarker } from './BlaxelSidebarMarker.js'
import { BlaxelSettings } from './BlaxelSettings.js'

export const inject = ['slots', 'sessions', 'conversation']

const BLOCK_PREFIX = 'Blaxel sandbox: '
const UNAVAILABLE_BLOCK = `${BLOCK_PREFIX}Sandbox unavailable. This session is still sandboxed, not local. Reconnect, or continue locally to drop the sandbox.`

/** Client plugins load before the first native session-list snapshot arrives. */
export function openWhenListed(ctx: BlaxelClientContext, sessionId: string): void {
  ctx.effect(() => {
    let opened = false
    const select = (): void => {
      if (opened || ctx.sessions.list.getSnapshot().byId[sessionId] === undefined) return
      opened = true
      ctx.sessions.open(sessionId)
    }
    const unsubscribe = ctx.sessions.list.subscribe(select)
    select()
    return unsubscribe
  })
}

export async function apply(ctx: BlaxelClientContext): Promise<void> {
  const mode = await getRuntimeMode()
  if (mode.mode === 'cloud') {
    const url = new URL(window.location.href)
    if (url.searchParams.has('bl_preview_token')) { url.searchParams.delete('bl_preview_token'); window.history.replaceState(null, '', url) }
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'blaxel-cloud-banner', order: 80 },
      (props: SessionSlotProps) => BlaxelCloudBanner({ ...props, mode, conversation: ctx.conversation })))
    openWhenListed(ctx, mode.sessionId)
    return
  }
  const location = new URL(window.location.href)
  const returning = location.searchParams.get('blaxel-return') ?? location.searchParams.get('blaxel-local')
  if (returning !== null) openWhenListed(ctx, returning)
  if (location.searchParams.has('blaxel-local')) { location.searchParams.delete('blaxel-local'); window.history.replaceState(null, '', location) }

  const setComposerBlock = (sessionId: string, reason?: string): void => {
    const blocks = ctx.conversation.blocks
    const current = blocks.storeFor(sessionId).getSnapshot()
    if (reason !== undefined) {
      if (current === undefined || current.reason.startsWith(BLOCK_PREFIX)) {
        blocks.set(sessionId, { reason: `${BLOCK_PREFIX}${reason}` })
      }
      return
    }
    if (current?.reason.startsWith(BLOCK_PREFIX) === true) blocks.set(sessionId, undefined)
  }
  const setUnavailableBlock = (sessionId: string, unavailable: boolean): void => {
    const blocks = ctx.conversation.blocks
    const current = blocks.storeFor(sessionId).getSnapshot()
    if (unavailable) {
      if (current === undefined || current.reason === UNAVAILABLE_BLOCK) blocks.set(sessionId, { reason: UNAVAILABLE_BLOCK })
      return
    }
    if (current?.reason === UNAVAILABLE_BLOCK) blocks.set(sessionId, undefined)
  }
  const ComposerAction = (props: Omit<BlaxelComposerActionProps, 'openSession' | 'setComposerBlock' | 'conversation'>): ReturnType<typeof BlaxelComposerAction> => (
    BlaxelComposerAction({
      ...props,
      conversation: ctx.conversation,
      openSession: sessionId => ctx.sessions.open(sessionId),
      setComposerBlock,
    })
  )
  const SandboxBanner = (props: { sessionId: string }): ReturnType<typeof BlaxelSandboxBanner> => (
    BlaxelSandboxBanner({ sessionId: props.sessionId, setUnavailableBlock })
  )

  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'blaxel-open',
    order: 90,
  }, ComposerAction))

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'blaxel-sandbox-banner',
    order: 80,
  }, SandboxBanner))

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'blaxel',
    order: 240,
    label: 'Blaxel',
  }, BlaxelSettings))

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'blaxel-session-markers',
    order: 0,
  }, BlaxelSidebarMarker))
}
