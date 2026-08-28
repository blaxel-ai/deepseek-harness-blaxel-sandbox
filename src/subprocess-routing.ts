import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { RoutingSubprocessRuntime } from './subprocess/router.js'

export const inject = ['agents', 'blaxelSessions']

export async function apply(ctx: Context): Promise<void> {
  const local = ctx.isolate('subprocess')
  const dispose = await local.plugin(LocalSubprocessRuntime)
  new RoutingSubprocessRuntime(ctx, local.get('subprocess') as SubprocessRuntime)
  ctx.effect(() => async () => dispose.dispose(), 'local subprocess backend')
}
