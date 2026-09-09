import { draftRequest } from './cloud/draft.js'
import { returnLanding } from './web/return-landing.js'
import { cloudHandoff } from './cloud.js'
import '@deepseek-ai/dsh-client-connection'
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
  readReconnectRequest,
  readSessionRequest,
  readCloudReturnRequest,
  readWorkspaceRequest,
  routeAction,
  writeJson,
} from './web/http.js'
import { configureMissingModelCredential, inspectModelReadiness, requireReadyModel } from './web/model-readiness.js'
import { inspectGitWorkspace } from './web/workspace-snapshot.js'

export const name = 'dsh-blaxel-web'

/** Error code the client turns into a consent prompt before a lost sandbox is replaced. */
export const SANDBOX_MISSING = 'sandbox-missing'
export const inject = [
  'webServer',
  'sessionController',
  'sessionProjections',
  'workspaceController',
  'settingsController',
  'credentialsController',
  'llm',
  'agentDefaultModel',
  'blaxelSessions',
  'blaxelCloud',
  'connection',
]

async function sourceIsIdle(ctx: BlaxelWebContext, sessionId: string, allowNew = false): Promise<boolean> {
  const { items } = await ctx.sessionController.list({}, new AbortController().signal)
  const source = items.find(item => item.sessionId === sessionId)
  return source === undefined ? allowNew : source.running === false
}

function localOrigin(req: BlaxelHttpRequest): string {
  const host = req.headers.host
  if (typeof host !== 'string' || !/^(?:localhost|127\.0\.0\.1):\d+$/.test(host)) throw new Error('Open DSH through its local browser address before moving a session')
  return `http://${host}`
}

async function handleOpen(req: BlaxelHttpRequest, res: BlaxelHttpResponse, ctx: BlaxelWebContext): Promise<void> {
  if (!permitsAction(req, 'open')) return writeJson(res, 403, { ok: false, error: 'action-not-authorized' })
  try {
    const request = await readMoveRequest(req)
    const workspace = await inspectGitWorkspace(request.cwd)
    const registered = await ctx.workspaceController.create({ path: workspace.cwd })
    await ctx.sessionController.create({ workspaceId: registered.workspace.workspaceId, sessionId: request.sessionId })
    writeJson(res, 200, { ok: true, ...await cloudHandoff(ctx).move(request.sessionId, workspace.cwd, localOrigin(req), request.title) })
  } catch (error) {
    writeJson(res, 422, { ok: false, error: error instanceof Error ? error.message : 'Could not create the cloud session' })
  }
}

async function handleMove(req: BlaxelHttpRequest, res: BlaxelHttpResponse, ctx: BlaxelWebContext): Promise<void> {
  if (!permitsAction(req, 'move')) return writeJson(res, 403, { ok: false, error: 'action-not-authorized' })
  try {
    const request = await readMoveRequest(req)
    writeJson(res, 200, { ok: true, ...await cloudHandoff(ctx).move(request.sessionId, request.cwd, localOrigin(req), request.title) })
  } catch (error) {
    writeJson(res, 422, { ok: false, error: error instanceof Error ? error.message : 'Could not move the cloud session' })
  }
}

async function handleReconnect(req: BlaxelHttpRequest, res: BlaxelHttpResponse, ctx: BlaxelWebContext): Promise<void> {
  if (!permitsAction(req, 'reconnect')) return writeJson(res, 403, { ok: false, error: 'action-not-authorized' })
  try {
    const { sessionId, recreate } = await readReconnectRequest(req)
    const binding = ctx.blaxelSessions.binding(sessionId)
    const result = await ctx.blaxelSessions.reconnect(sessionId)
    if (result === 'missing') {
      // Replacing a lost sandbox discards whatever lived only inside it, so it
      // never happens without the user's explicit consent.
      if (!recreate) return writeJson(res, 409, { ok: false, error: SANDBOX_MISSING })
      if (!await sourceIsIdle(ctx, sessionId)) throw new Error('Wait for the current turn to finish before reconnecting this sandbox')
      await requireReadyModel(ctx, sessionId)
      if (binding?.cloud !== undefined) {
        await cloudHandoff(ctx).discard(sessionId)
        const moved = await cloudHandoff(ctx).move(sessionId, binding.sourceRoot, binding.cloud.localOrigin, binding.title)
        return writeJson(res, 200, { ok: true, outcome: 'recreated', url: moved.url })
      }
      await ctx.blaxelSessions.recreateMissing(sessionId)
      return writeJson(res, 200, { ok: true, outcome: 'recreated' })
    }
    const opened = binding?.cloud === undefined ? {} : await cloudHandoff(ctx).open(sessionId)
    writeJson(res, 200, { ok: true, outcome: 'reconnected', ...opened })
  } catch (error) {
    writeJson(res, 422, { ok: false, error: error instanceof Error ? error.message : 'Could not reconnect the sandbox' })
  }
}

async function handleClose(req: BlaxelHttpRequest, res: BlaxelHttpResponse, ctx: BlaxelWebContext): Promise<void> {
  if (!permitsAction(req, 'close')) return writeJson(res, 403, { ok: false, error: 'action-not-authorized' })
  try {
    const { sessionId } = await readSessionRequest(req)
    await cloudHandoff(ctx).discard(sessionId)
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
    const { sessionId, reviewHash } = await readCloudReturnRequest(req)
    if (reviewHash !== undefined || ctx.blaxelSessions.binding(sessionId)?.cloud !== undefined) {
      if (reviewHash === undefined) throw new Error('Review the changes before moving this cloud session back')
      return writeJson(res, 200, { ok: true, ...await cloudHandoff(ctx).returnLocal(sessionId, reviewHash) })
    }
    if (!await sourceIsIdle(ctx, sessionId)) throw new Error('Wait for the current turn to finish before moving changes locally')
    writeJson(res, 200, { ok: true, ...await ctx.blaxelSessions.moveChangesLocal(sessionId) })
  } catch (error) {
    writeJson(res, 422, { ok: false, error: error instanceof Error ? error.message : 'Could not move sandbox changes locally' })
  }
}

export function apply(ctx: BlaxelWebContext): void {
  // A committed same-origin landing lets the browser send DSH's Strict cookie.
  // This public page contains no session data and performs no transfer action.
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/blaxel/return', handler: (req, res) => {
    const html = req.method === 'GET' ? returnLanding(req.url ?? '') : undefined
    res.writeHead(html === undefined ? 400 : 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" })
    res.end(html ?? 'Invalid return address')
  } }))
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/blaxel/api',
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) return writeJson(res, rejection, { ok: false, error: 'action-not-authorized' })
      const action = routeAction(req)
      if (action === 'draft') return await draftRequest(req, res, cloudHandoff(ctx).drafts, id => !cloudHandoff(ctx).blocks(id))
      if (action === 'mode' && req.method === 'GET') return writeJson(res, 200, { ok: true, mode: 'local' })
      if ((action === 'cloud-open' || action === 'review') && req.method === 'POST') {
        if (!permitsAction(req, action)) return writeJson(res, 403, { ok: false, error: 'action-not-authorized' })
        try {
          const { sessionId } = await readSessionRequest(req)
          const result = action === 'cloud-open' ? await cloudHandoff(ctx).open(sessionId) : await cloudHandoff(ctx).review(sessionId)
          return writeJson(res, 200, { ok: true, ...result })
        } catch (error) {
          return writeJson(res, 422, { ok: false, error: error instanceof Error ? error.message : 'The cloud session could not be reached' })
        }
      }
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
      if (action === 'reconnect' && req.method === 'POST') return await handleReconnect(req, res, ctx)
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
