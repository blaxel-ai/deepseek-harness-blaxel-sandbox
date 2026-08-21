import { randomUUID } from 'node:crypto'
import type { BlaxelRuntime } from './runtime-service.js'
import { BlaxelChildManager } from './web/child-manager.js'
import type { BlaxelHttpRequest, BlaxelHttpResponse, BlaxelWebContext } from './web/context.js'
import { permitsAction, readWorkspaceCwd, routeAction, writeJson } from './web/http.js'
import { inspectGitWorkspace } from './web/workspace-snapshot.js'

export const name = 'dsh-blaxel-web'
export const inject = ['webServer', 'apiProxy']

const ACTIVE = process.env.DSH_BLAXEL_ACTIVE === '1'

async function bootstrapRemoteSession(ctx: BlaxelWebContext): Promise<void> {
  const workspace = await ctx.apiProxy.workspace.create({
    rpcId: randomUUID(),
    payload: { path: process.env.DSH_BLAXEL_SOURCE_CWD || process.cwd() },
  })
  if (!workspace.result.ok) throw new Error(`Could not register the Blaxel workspace: ${workspace.result.error.message}`)

  const created = await ctx.apiProxy.sessions.create({
    rpcId: randomUUID(),
    payload: { workspaceId: workspace.result.value.workspace.workspaceId },
  })
  if (!created.result.ok) throw new Error(`Could not create the Blaxel session: ${created.result.error.message}`)
}

async function writeStatus(
  ctx: BlaxelWebContext,
  children: BlaxelChildManager,
  res: BlaxelHttpResponse,
): Promise<void> {
  if (!ACTIVE) {
    writeJson(res, 200, { ok: true, mode: 'local', child: children.status() })
    return
  }
  const runtime = ctx.get('blaxel') as BlaxelRuntime | undefined
  if (runtime === undefined) {
    writeJson(res, 503, { ok: false, mode: 'blaxel', state: 'unavailable' })
    return
  }
  try {
    await runtime.getSandbox()
    writeJson(res, 200, {
      ok: true,
      mode: 'blaxel',
      state: 'ready',
      sandbox: {
        name: runtime.name,
        cwd: runtime.cwd,
        workspaceRoot: runtime.workspaceRoot,
        sourceCwd: process.env.DSH_BLAXEL_SOURCE_CWD,
      },
    })
  } catch {
    writeJson(res, 503, { ok: false, mode: 'blaxel', state: 'failed' })
  }
}

async function handleWorkspaceAction(
  action: 'check' | 'open',
  req: BlaxelHttpRequest,
  res: BlaxelHttpResponse,
  children: BlaxelChildManager,
): Promise<void> {
  if (!permitsAction(req, action)) {
    writeJson(res, 403, { ok: false, error: 'action-not-authorized' })
    return
  }
  try {
    const cwd = await readWorkspaceCwd(req)
    if (action === 'check') {
      writeJson(res, 200, { ok: true, workspace: await inspectGitWorkspace(cwd) })
    } else {
      writeJson(res, 200, { ok: true, ...await children.open(cwd) })
    }
  } catch (error) {
    writeJson(res, action === 'check' ? 422 : 500, {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not open Blaxel DSH',
    })
  }
}

async function handleClose(
  req: BlaxelHttpRequest,
  res: BlaxelHttpResponse,
  children: BlaxelChildManager,
): Promise<void> {
  if (!permitsAction(req, 'close')) {
    writeJson(res, 403, { ok: false, error: 'action-not-authorized' })
    return
  }
  if (ACTIVE) {
    writeJson(res, 202, { ok: true })
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 50)
    return
  }
  await children.close()
  writeJson(res, 200, { ok: true })
}

export async function apply(ctx: BlaxelWebContext): Promise<void> {
  if (ACTIVE) await bootstrapRemoteSession(ctx)

  const children = new BlaxelChildManager()
  ctx.effect(() => async () => children.close(), 'blaxel child DSH teardown')
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/blaxel/api',
    handler: async (req, res) => {
      const action = routeAction(req)
      if (action === 'status' && req.method === 'GET') return await writeStatus(ctx, children, res)
      if ((action === 'check' || action === 'open') && req.method === 'POST') {
        return await handleWorkspaceAction(action, req, res, children)
      }
      if (action === 'close' && req.method === 'POST') return await handleClose(req, res, children)
      writeJson(res, 404, { ok: false, error: 'not-found' })
    },
  }), 'blaxel web API')
}
