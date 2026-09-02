import { randomUUID } from 'node:crypto'
import type { BlaxelHttpRequest, BlaxelHttpResponse, BlaxelWebContext } from './web/context.js'
import {
  permitsAction,
  permitsRead,
  readBrowserLoginRequest,
  readConfigurationRequest,
  readLaunchRequest,
  readLoginRequest,
  readModelCredentialRequest,
  readMoveRequest,
  readSessionRequest,
  readWorkspaceRequest,
  routeAction,
  writeJson,
} from './web/http.js'
import { configureMissingModelCredential, inspectModelReadiness, requireReadyModel } from './web/model-readiness.js'
import { inspectGitWorkspace } from './web/workspace-snapshot.js'

export const name = 'dsh-blaxel-web'
export const inject = ['webServer', 'apiProxy', 'blaxelSessions']

async function rpc<T>(call: Promise<{ result: { ok: true; value: T } | { ok: false; error: { message: string } } }>): Promise<T> {
  const response = await call
  if (!response.result.ok) throw new Error(response.result.error.message)
  return response.result.value
}

async function sourceIsIdle(ctx: BlaxelWebContext, sessionId: string): Promise<boolean> {
  const { items } = await rpc(ctx.apiProxy.sessions.list({ rpcId: randomUUID(), payload: {} }))
  return items.find(item => item.sessionId === sessionId)?.running === false
}

async function handleOpen(req: BlaxelHttpRequest, res: BlaxelHttpResponse, ctx: BlaxelWebContext): Promise<void> {
  if (!permitsAction(req, 'open')) return writeJson(res, 403, { ok: false, error: 'action-not-authorized' })
  let prepared: Awaited<ReturnType<typeof ctx.blaxelSessions.prepare>> | undefined
  try {
    const request = await readMoveRequest(req)
    await requireReadyModel(ctx, request.sessionId)
    const workspace = await inspectGitWorkspace(request.cwd)
    const registered = await rpc(ctx.apiProxy.workspace.create({
      rpcId: randomUUID(),
      payload: { path: workspace.cwd },
    }))
    prepared = await ctx.blaxelSessions.prepare(workspace.cwd, 'open')
    const created = await rpc(ctx.apiProxy.sessions.create({
      rpcId: randomUUID(),
      payload: {
        workspaceId: registered.workspace.workspaceId,
        sessionId: request.sessionId,
      },
    }))
    await ctx.blaxelSessions.bind(prepared, created.sessionId, request.title)
    prepared = undefined
    writeJson(res, 200, { ok: true, sessionId: created.sessionId })
  } catch (error) {
    if (prepared !== undefined) await ctx.blaxelSessions.discard(prepared)
    writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Could not start the sandbox session' })
  }
}

async function handleMove(req: BlaxelHttpRequest, res: BlaxelHttpResponse, ctx: BlaxelWebContext): Promise<void> {
  if (!permitsAction(req, 'move')) return writeJson(res, 403, { ok: false, error: 'action-not-authorized' })
  let prepared: Awaited<ReturnType<typeof ctx.blaxelSessions.prepare>> | undefined
  try {
    const request = await readMoveRequest(req)
    if (!await sourceIsIdle(ctx, request.sessionId)) throw new Error('Wait for the current turn to finish before moving this session')
    await requireReadyModel(ctx, request.sessionId)
    prepared = await ctx.blaxelSessions.prepare(request.cwd, 'move')
    if (!await sourceIsIdle(ctx, request.sessionId)) throw new Error('The session started running while its sandbox was being prepared')
    await ctx.blaxelSessions.bind(prepared, request.sessionId, request.title)
    prepared = undefined
    writeJson(res, 200, { ok: true, sessionId: request.sessionId })
  } catch (error) {
    if (prepared !== undefined) await ctx.blaxelSessions.discard(prepared)
    writeJson(res, 422, { ok: false, error: error instanceof Error ? error.message : 'Could not create the sandbox session' })
  }
}

async function handleClose(req: BlaxelHttpRequest, res: BlaxelHttpResponse, ctx: BlaxelWebContext): Promise<void> {
  if (!permitsAction(req, 'close')) return writeJson(res, 403, { ok: false, error: 'action-not-authorized' })
  try {
    const { sessionId } = await readSessionRequest(req)
    await ctx.blaxelSessions.close(sessionId)
    writeJson(res, 200, { ok: true })
  } catch (error) {
    writeJson(res, 422, { ok: false, error: error instanceof Error ? error.message : 'Could not stop the sandbox' })
  }
}

async function handleDivergence(req: BlaxelHttpRequest, res: BlaxelHttpResponse, ctx: BlaxelWebContext): Promise<void> {
  if (!permitsAction(req, 'divergence')) return writeJson(res, 403, { ok: false, error: 'action-not-authorized' })
  try {
    const { sessionId } = await readSessionRequest(req)
    const result = await ctx.blaxelSessions.divergence(sessionId)
    if (!result.available) return writeJson(res, 422, { ok: false, error: result.reason })
    writeJson(res, 200, { ok: true, divergence: result.divergence })
  } catch (error) {
    writeJson(res, 422, { ok: false, error: error instanceof Error ? error.message : 'Could not inspect sandbox changes' })
  }
}

async function handleSyncLocal(req: BlaxelHttpRequest, res: BlaxelHttpResponse, ctx: BlaxelWebContext): Promise<void> {
  if (!permitsAction(req, 'sync-local')) return writeJson(res, 403, { ok: false, error: 'action-not-authorized' })
  try {
    const { sessionId } = await readSessionRequest(req)
    if (!await sourceIsIdle(ctx, sessionId)) throw new Error('Wait for the current turn to finish before moving changes locally')
    writeJson(res, 200, { ok: true, ...await ctx.blaxelSessions.moveChangesLocal(sessionId) })
  } catch (error) {
    writeJson(res, 422, { ok: false, error: error instanceof Error ? error.message : 'Could not move sandbox changes locally' })
  }
}

export function apply(ctx: BlaxelWebContext): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/blaxel/api',
    handler: async (req, res) => {
      const action = routeAction(req)
      if (action === 'status' && req.method === 'GET') {
        if (!permitsRead(req)) return writeJson(res, 403, { ok: false, error: 'action-not-authorized' })
        return writeJson(res, 200, {
          ok: true,
          ...await ctx.blaxelSessions.status(),
          settings: await ctx.blaxelSessions.settingsStatus(),
        })
      }
      if (action === 'check' && req.method === 'POST') {
        if (!permitsAction(req, 'check')) return writeJson(res, 403, { ok: false, error: 'action-not-authorized' })
        try {
          const request = await readLaunchRequest(req)
          return writeJson(res, 200, { ok: true, workspace: await inspectGitWorkspace(request.cwd) })
        } catch (error) {
          return writeJson(res, 422, { ok: false, error: error instanceof Error ? error.message : 'Could not inspect this workspace' })
        }
      }
      if (action === 'model-readiness' && req.method === 'POST') {
        if (!permitsAction(req, 'model-readiness')) return writeJson(res, 403, { ok: false, error: 'action-not-authorized' })
        try {
          const { sessionId } = await readSessionRequest(req)
          return writeJson(res, 200, { ok: true, readiness: await inspectModelReadiness(ctx, sessionId) })
        } catch (error) {
          return writeJson(res, 422, { ok: false, error: error instanceof Error ? error.message : 'Could not verify the selected model' })
        }
      }
      if (action === 'model-credential' && req.method === 'POST') {
        if (!permitsAction(req, 'model-credential')) return writeJson(res, 403, { ok: false, error: 'action-not-authorized' })
        try {
          const { sessionId, credential } = await readModelCredentialRequest(req)
          const readiness = await configureMissingModelCredential(ctx, sessionId, credential)
          return writeJson(res, 200, { ok: true, readiness })
        } catch (error) {
          return writeJson(res, 422, { ok: false, error: error instanceof Error ? error.message : 'Could not save the model credential' })
        }
      }
      if (action === 'open' && req.method === 'POST') return await handleOpen(req, res, ctx)
      if (action === 'move' && req.method === 'POST') return await handleMove(req, res, ctx)
      if (action === 'divergence' && req.method === 'POST') return await handleDivergence(req, res, ctx)
      if (action === 'sync-local' && req.method === 'POST') return await handleSyncLocal(req, res, ctx)
      if (action === 'close' && req.method === 'POST') return await handleClose(req, res, ctx)
      if (action === 'configure' && req.method === 'POST') {
        if (!permitsAction(req, 'configure')) return writeJson(res, 403, { ok: false, error: 'action-not-authorized' })
        try {
          const { defaults } = await readConfigurationRequest(req)
          return writeJson(res, 200, { ok: true, defaults: await ctx.blaxelSessions.saveDefaults(defaults) })
        } catch (error) {
          return writeJson(res, 422, { ok: false, error: error instanceof Error ? error.message : 'Could not save sandbox defaults' })
        }
      }
      if (action === 'workspace' && req.method === 'POST') {
        if (!permitsAction(req, 'workspace')) return writeJson(res, 403, { ok: false, error: 'action-not-authorized' })
        try {
          const { workspace } = await readWorkspaceRequest(req)
          return writeJson(res, 200, { ok: true, settings: await ctx.blaxelSessions.switchWorkspace(workspace) })
        } catch (error) {
          return writeJson(res, 422, { ok: false, error: error instanceof Error ? error.message : 'Could not switch workspaces' })
        }
      }
      if (action === 'login' && req.method === 'POST') {
        if (!permitsAction(req, 'login')) return writeJson(res, 403, { ok: false, error: 'action-not-authorized' })
        try {
          const { workspace, apiKey } = await readLoginRequest(req)
          return writeJson(res, 200, { ok: true, settings: await ctx.blaxelSessions.login(workspace, apiKey) })
        } catch (error) {
          return writeJson(res, 422, { ok: false, error: error instanceof Error ? error.message : 'Could not connect the workspace' })
        }
      }
      if (action === 'oauth-start' && req.method === 'POST') {
        if (!permitsAction(req, 'oauth-start')) return writeJson(res, 403, { ok: false, error: 'action-not-authorized' })
        try {
          return writeJson(res, 200, { ok: true, login: await ctx.blaxelSessions.beginBrowserLogin() })
        } catch (error) {
          return writeJson(res, 422, { ok: false, error: error instanceof Error ? error.message : 'Could not start browser sign-in' })
        }
      }
      if (action === 'oauth-poll' && req.method === 'POST') {
        if (!permitsAction(req, 'oauth-poll')) return writeJson(res, 403, { ok: false, error: 'action-not-authorized' })
        try {
          const { flowId } = await readBrowserLoginRequest(req)
          return writeJson(res, 200, { ok: true, login: await ctx.blaxelSessions.pollBrowserLogin(flowId) })
        } catch (error) {
          return writeJson(res, 422, { ok: false, error: error instanceof Error ? error.message : 'Could not finish browser sign-in' })
        }
      }
      if (action === 'oauth-complete' && req.method === 'POST') {
        if (!permitsAction(req, 'oauth-complete')) return writeJson(res, 403, { ok: false, error: 'action-not-authorized' })
        try {
          const { flowId, workspace } = await readBrowserLoginRequest(req)
          return writeJson(res, 200, { ok: true, settings: await ctx.blaxelSessions.completeBrowserLogin(flowId, workspace) })
        } catch (error) {
          return writeJson(res, 422, { ok: false, error: error instanceof Error ? error.message : 'Could not save browser sign-in' })
        }
      }
      if (action === 'logout' && req.method === 'POST') {
        if (!permitsAction(req, 'logout')) return writeJson(res, 403, { ok: false, error: 'action-not-authorized' })
        try {
          const { workspace } = await readWorkspaceRequest(req)
          return writeJson(res, 200, { ok: true, settings: await ctx.blaxelSessions.logout(workspace) })
        } catch (error) {
          return writeJson(res, 422, { ok: false, error: error instanceof Error ? error.message : 'Could not sign out' })
        }
      }
      if (action === 'test' && req.method === 'POST') {
        if (!permitsAction(req, 'test')) return writeJson(res, 403, { ok: false, error: 'action-not-authorized' })
        try {
          return writeJson(res, 200, { ok: true, ...await ctx.blaxelSessions.testConnection() })
        } catch (error) {
          return writeJson(res, 422, { ok: false, error: error instanceof Error ? error.message : 'Could not reach Blaxel' })
        }
      }
      if (action === 'install-skills' && req.method === 'POST') {
        if (!permitsAction(req, 'install-skills')) return writeJson(res, 403, { ok: false, error: 'action-not-authorized' })
        try {
          return writeJson(res, 200, { ok: true, capabilities: await ctx.blaxelSessions.installSkills() })
        } catch (error) {
          return writeJson(res, 422, { ok: false, error: error instanceof Error ? error.message : 'Could not install Blaxel skills' })
        }
      }
      if (action === 'mcp-login' && req.method === 'POST') {
        if (!permitsAction(req, 'mcp-login')) return writeJson(res, 403, { ok: false, error: 'action-not-authorized' })
        try {
          return writeJson(res, 200, { ok: true, capabilities: await ctx.blaxelSessions.connectMcp() })
        } catch (error) {
          return writeJson(res, 422, { ok: false, error: error instanceof Error ? error.message : 'Could not connect Blaxel MCP' })
        }
      }
      if (action === 'mcp-logout' && req.method === 'POST') {
        if (!permitsAction(req, 'mcp-logout')) return writeJson(res, 403, { ok: false, error: 'action-not-authorized' })
        try {
          return writeJson(res, 200, { ok: true, capabilities: await ctx.blaxelSessions.disconnectMcp() })
        } catch (error) {
          return writeJson(res, 422, { ok: false, error: error instanceof Error ? error.message : 'Could not disconnect Blaxel MCP' })
        }
      }
      writeJson(res, 404, { ok: false, error: 'not-found' })
    },
  }), 'blaxel web API')
}
