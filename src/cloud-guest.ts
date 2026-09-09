import { writePrivateJson } from './cloud/private-json.js'
import { DraftStore, draftRequest, type SavedDraft } from './cloud/draft.js'
import { timingSafeEqual } from 'node:crypto'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import '@deepseek-ai/dsh-client-connection'
import '@deepseek-ai/dsh-permission-presets'
import type { BlaxelHttpRequest } from './web/context.js'
import { writeJson } from './web/http.js'
import type { CloudExecutionOwner } from './cloud-gateway.js'
import { remainingSeedEvents, validateSessionTransfer } from './cloud/session-transfer.js'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import { requireTransferSize, exportImages, importImages, type TransferImage } from './cloud/attachments.js'
import { relatedSessions, validateRelated } from './cloud/related-sessions.js'

export const CLOUD_ROOT = '/opt/dsh-blaxel'
export interface CloudSeed {
  session: SessionInspection
  localOrigin: string
  previewOrigin: string
  sandboxName: string
  workspace: string
  continuation?: UserMessage
  images?: TransferImage[]
  related?: SessionInspection[]
  draft?: SavedDraft
}

function authorized(req: BlaxelHttpRequest): boolean {
  const secret = process.env.DSH_BLAXEL_CONTROL_TOKEN
  const supplied = req.headers.authorization
  if (!secret || typeof supplied !== 'string') return false
  const expected = Buffer.from(`Bearer ${secret}`)
  const actual = Buffer.from(supplied)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** A full native DSH Web host inside one private sandbox; no dependency on the originating host. */
export default class BlaxelCloudGuest extends Service implements CloudExecutionOwner {
  static inject = ['sessions', 'sessionPersistence', 'sessionController', 'webServer', 'connection', 'agents', 'attachments', 'permissionPresets']
  readonly drafts = new DraftStore()
  private seed?: CloudSeed
  private agent?: Agent
  private held = true
  private freezing = false
  private resumeMessages: Array<{ sessionId: string; message: UserMessage }> = []
  private freezeResult?: Promise<Record<string, unknown>>
  private releaseMaintenance?: () => void
  private readonly ready: Promise<void>

  constructor(ctx: Context) {
    super(ctx, 'blaxelCloud')
    this.ready = this.initialize()
    void this.ready.catch(() => undefined)
    ctx.on('agent/request', async ({ agent, signal }, next) => {
      if (this.freezing && agent.id === this.agent?.id) {
        agent.cancel({ kind: 'hook', reason: 'Moving this session back to your computer' }, { keepInbox: true })
        signal.throwIfAborted()
      }
      // Descendants finish their current work before the checkpoint. One-shot
      // children cannot be resumed after a process restart.
      if (this.held) throw new Error('This cloud session is paused for transfer')
      ctx.permissionPresets.set(agent.session, 'danger-full-access')
      return await next()
    })
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix', path: '/blaxel/api',
      handler: async (req, res) => {
        const path = (req.url ?? '').split('?', 1)[0]
        if (path === '/blaxel/api/cloud-control' && req.method === 'POST') {
          if (!authorized(req)) return writeJson(res, 401, { ok: false, error: 'Authentication required' })
          try {
            const command = req.headers['x-dsh-cloud-command']
            await this.ready
            writeJson(res, 200, { ok: true, ...await this.control(typeof command === 'string' ? command : '') })
          } catch (error) {
            writeJson(res, 409, { ok: false, error: error instanceof Error ? error.message : 'Cloud session operation failed' })
          }
          return
        }
        if (ctx.connection.requestRejection(req) !== undefined) return writeJson(res, 403, { ok: false, error: 'Authentication required' })
        if (path === '/blaxel/api/draft') return await draftRequest(req, res, this.drafts, () => !this.held && !this.freezing)
        if (path === '/blaxel/api/access-link' && req.method === 'GET') {
          try { await this.ready; return writeJson(res, 200, { ok: true, url: this.ctx.connection.authenticatedUrl(this.seed!.previewOrigin) }) }
          catch { return writeJson(res, 409, { ok: false, error: 'Reopen this session from the original computer to renew its private link.' }) }
        }
        if (path === '/blaxel/api/mode' && req.method === 'GET') {
          try {
            await this.ready
            return writeJson(res, 200, { ok: true, mode: 'cloud', sessionId: this.seed!.session.meta.id,
              localOrigin: this.seed!.localOrigin, sandboxName: this.seed!.sandboxName, workspace: this.seed!.workspace,
              running: this.agent?.status === 'running', held: this.held || this.freezing })
          } catch { return writeJson(res, 503, { ok: false, error: 'The cloud session could not be restored' }) }
        }
        writeJson(res, 404, { ok: false, error: 'Unknown cloud action' })
      },
    }))
  }

  blocks(_sessionId: string): boolean {
    // This dedicated host transfers as one unit, including newly created children.
    return this.held || this.freezing
  }

  blocksAll(): boolean { return this.held || this.freezing }

  private async initialize(): Promise<void> {
    await this.ctx.get('loader')?.await()
    const seed = JSON.parse(await readFile(`${CLOUD_ROOT}/seed.json`, 'utf8')) as CloudSeed
    seed.session = validateSessionTransfer(seed.session, seed.session.meta.id)
    this.seed = seed
    if (seed.draft !== undefined && await this.drafts.get(seed.session.meta.id) === undefined) await this.drafts.save(seed.session.meta.id, seed.draft.draft)
    seed.related = validateRelated(seed.session.meta.id, seed.related)
    await importImages(this.ctx.attachments, [seed.session, ...seed.related], seed.images)
    try { await readFile(`${CLOUD_ROOT}/held`); this.held = true } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.held = false
    }
    try {
      this.resumeMessages = JSON.parse(await readFile(`${CLOUD_ROOT}/freeze-request.json`, 'utf8'))
      this.held = true
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    try { this.freezeResult = Promise.resolve(JSON.parse(await readFile(`${CLOUD_ROOT}/frozen.json`, 'utf8'))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    let releasing = false
    try {
      this.resumeMessages = JSON.parse(await readFile(`${CLOUD_ROOT}/release.json`, 'utf8'))
      this.held = true
      releasing = true
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const id = SessionId(seed.session.meta.id)
    const existing = new Set((await this.ctx.sessionPersistence.list()).map(meta => meta.id))
    for (const session of [seed.session, ...seed.related]) {
      let tail = session.events
      if (existing.has(session.meta.id)) tail = remainingSeedEvents(session, await this.ctx.sessionPersistence.inspect(session.meta.id))
      else await this.ctx.sessionPersistence.create(session.meta, session.inheritedEventCount)
      if (tail.length > 0) await this.ctx.sessionPersistence.append(session.meta.id, tail)
    }
    await this.ctx.sessionController.create({ sessionId: id, cwd: seed.session.meta.cwd })
    const found = await this.ctx.sessionController.resolveAgent(id)
    if ('error' in found) throw new Error(found.error.message)
    this.agent = found.agent as Agent
    this.ctx.permissionPresets.set(this.agent.session, 'danger-full-access')
    await this.ctx.sessions.flush(this.agent.session)
    if (releasing) await this.control('release')
  }

  private async control(command: string): Promise<Record<string, unknown>> {
    const agent = this.agent!
    const seed = this.seed!
    if (command === 'health') return { running: agent.status === 'running', held: this.held, sessionId: agent.id }
    if (command === 'open') return { url: this.ctx.connection.authenticatedUrl(seed.previewOrigin) }
    if (command === 'start') {
      if (this.held) throw new Error('The cloud session is paused for return')
      const message = seed.continuation
      if (message !== undefined) {
        const alreadyQueued = agent.session.snapshotEvents().some(event =>
          event.type === 'agent/inbox/spliced' && event.data.inserted.some(item => item.id === message.id))
        if (!alreadyQueued) {
          agent.followup(message)
          await this.ctx.sessions.flush(agent.session)
        }
      }
      return { running: agent.status === 'running' }
    }
    if (command === 'freeze') {
      if (this.freezeResult === undefined) this.freezeResult = this.freeze()
      try { return await this.freezeResult } catch (error) { this.freezeResult = undefined; throw error }
    }
    if (command === 'release') {
      // A timed-out caller cannot release ownership ahead of an in-flight checkpoint.
      await this.freezeResult?.catch(() => undefined)
      for (const pending of this.resumeMessages) {
        if (this.ctx.agents.get(SessionId(pending.sessionId)) === undefined) throw new Error('An interrupted child agent must be restored before releasing this return; the cloud checkpoint was preserved')
      }
      // A durable release intent supersedes the frozen snapshot on restart.
      // Keep admission closed until old checkpoint files are removed.
      await writePrivateJson(`${CLOUD_ROOT}/release.json`, this.resumeMessages)
      await rm(`${CLOUD_ROOT}/frozen.json`, { force: true })
      await rm(`${CLOUD_ROOT}/freeze-request.json`, { force: true })
      await rm(`${CLOUD_ROOT}/held`, { force: true })
      this.held = false
      this.freezing = false
      this.freezeResult = undefined
      this.releaseMaintenance?.()
      this.releaseMaintenance = undefined
      for (const pending of this.resumeMessages) {
        const live = this.ctx.agents.get(SessionId(pending.sessionId))
        if (live === undefined) throw new Error('The interrupted child agent must be reopened before releasing this return')
        const queued = live.session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced' && event.data.inserted.some(item => item.id === pending.message.id))
        if (!queued) live.followup(pending.message)
        await this.ctx.sessions.flush(live.session)
      }
      await rm(`${CLOUD_ROOT}/release.json`, { force: true })
      this.resumeMessages = []
      return { released: true }
    }
    throw new Error('Unknown cloud control command')
  }

  private async freeze(): Promise<Record<string, unknown>> {
      const agent = this.agent!
      this.freezing = true
      if (this.resumeMessages.length === 0) {
        this.resumeMessages = this.ctx.agents.list().filter(item => item.id === agent.id && item.status === 'running').map(item => ({ sessionId: item.id,
          message: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'The move back to local was cancelled. Continue the interrupted task here on Blaxel using the existing conversation and files.' }] }) }))
        await writePrivateJson(`${CLOUD_ROOT}/freeze-request.json`, this.resumeMessages)
      }
      const continueTask = this.resumeMessages.length > 0 || this.ctx.agents.list().some(item => item.status === 'running')
      // Recheck because a working child may create another descendant while
      // settling. Browser admission is already fenced for the entire host.
      while (this.ctx.agents.list().some(item => item.status === 'running')) {
        for (const live of this.ctx.agents.list()) if (live.status === 'running') await live.whenIdle()
      }
      this.held = true
      await writeFile(`${CLOUD_ROOT}/held`, 'returning\n', { mode: 0o600 })
      if (this.releaseMaintenance === undefined) {
        const hold = new Promise<void>(resolve => { this.releaseMaintenance = resolve })
        void agent.runMaintenance(async () => await hold).catch(() => undefined)
      }
      await this.ctx.sessions.flush(agent.session)
      const session = validateSessionTransfer({ meta: agent.session.header, inheritedEventCount: agent.session.inheritedEventCount, events: agent.session.snapshotEvents() }, agent.id)
      const related = await relatedSessions(this.ctx, agent.id)
      const result = { session, related, continueTask, draft: await this.drafts.get(agent.id), images: await exportImages(this.ctx.attachments, [session, ...related]) }
      requireTransferSize(result)
      await writePrivateJson(`${CLOUD_ROOT}/frozen.json`, result)
      return result
  }
}
