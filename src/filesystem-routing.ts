import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { RoutingFileSystem } from './filesystem/router.js'

export const inject = ['agents', 'blaxelSessions', 'sandboxPolicy']

export async function apply(ctx: Context): Promise<void> {
  const local = ctx.isolate('fs')
  const dispose = await local.plugin(SandboxedFileSystem, {})
  new RoutingFileSystem(ctx, local.get('fs') as FileSystem)
  ctx.effect(() => async () => dispose.dispose(), 'local filesystem backend')
}
