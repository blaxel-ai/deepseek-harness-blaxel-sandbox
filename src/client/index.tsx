import type { BlaxelClientContext } from './context.js'
import { BlaxelComposerAction, type BlaxelComposerActionProps } from './BlaxelComposerAction.js'
import { BlaxelSandboxBanner } from './BlaxelSandboxBanner.js'
import { BlaxelSidebarMarker } from './BlaxelSidebarMarker.js'
import { BlaxelSettings } from './BlaxelSettings.js'

export const inject = ['slots', 'sessions', 'conversation']

const BLOCK_PREFIX = 'Blaxel sandbox: '

export function apply(ctx: BlaxelClientContext): void {
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
  const ComposerAction = (props: Omit<BlaxelComposerActionProps, 'openSession' | 'setComposerBlock'>): ReturnType<typeof BlaxelComposerAction> => (
    BlaxelComposerAction({
      ...props,
      openSession: sessionId => ctx.sessions.open(sessionId),
      setComposerBlock,
    })
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
  }, BlaxelSandboxBanner))

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
