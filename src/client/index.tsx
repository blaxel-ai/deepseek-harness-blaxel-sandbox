import type { BlaxelClientContext } from './context.js'
import { BlaxelComposerAction } from './BlaxelComposerAction.js'
import { BlaxelSettings } from './BlaxelSettings.js'
import { getStatus } from './api.js'

export const inject = ['slots', 'sessions']

export function apply(ctx: BlaxelClientContext): void {
  ctx.effect(() => {
    let stopped = false
    let unsubscribe: (() => void) | undefined
    void getStatus().then((status) => {
      if (stopped || status.mode !== 'blaxel') return
      const openBootstrapSession = (): void => {
        const list = ctx.sessions.list.getSnapshot()
        const sessionId = list.ids.find(id => list.byId[id]?.blank === true && list.byId[id]?.cwd === (status.sandbox.sourceCwd ?? status.sandbox.cwd))
        if (sessionId === undefined) return
        if (list.current !== sessionId) ctx.sessions.open(sessionId)
        unsubscribe?.()
        unsubscribe = undefined
      }
      unsubscribe = ctx.sessions.list.subscribe(openBootstrapSession)
      openBootstrapSession()
    }).catch(() => undefined)
    return () => {
      stopped = true
      unsubscribe?.()
    }
  }, 'blaxel bootstrap session selection')

  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'blaxel-open',
    order: 90,
  }, BlaxelComposerAction))

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'blaxel',
    order: 240,
    label: 'Blaxel',
  }, BlaxelSettings))
}
