import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { defaultBindingStorePath } from './session-runtime/binding-store.js'
import { writePrivateJson } from './cloud/private-json.js'
import { DraftStore } from './cloud/draft.js'
import { createHash, randomBytes } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import type { BlaxelWebContext } from './web/context.js'
import type { CloudBinding } from './session-runtime/binding-store.js'
import { cloudModel } from './cloud/model.js'
import { bootCloudHost, cloudRequest, waitForCloudHost } from './cloud/bootstrap.js'
import { importSessionTail, sessionPrefixHash, validateSessionTransfer, withLocalPermissions } from './cloud/session-transfer.js'
import { divergenceReader } from './web/divergence.js'
import { applySandboxPatch } from './web/local-sync.js'
import type { CloudExecutionOwner } from './cloud-gateway.js'
import { requireTransferSize, exportImages, importImages, type TransferImage } from './cloud/attachments.js'
import { relatedSessions, relocateSession, validateRelated } from './cloud/related-sessions.js'

export function cloudHandoff(ctx: BlaxelWebContext): BlaxelCloudHandoff {
  return ctx.blaxelCloud as BlaxelCloudHandoff
}

function inspect(session: Session): SessionInspection {
  return validateSessionTransfer({ meta: session.header, inheritedEventCount: session.inheritedEventCount, events: session.snapshotEvents() }, session.id)
}

/** Owns the transfer transaction; the sandbox owns every model/tool step after handoff. */
export default class BlaxelCloudHandoff extends Service implements CloudExecutionOwner {
  static inject = ['blaxelSessions', 'agents', 'sessions', 'sessionPersistence', 'sessionController', 'sessionProjections', 'llm', 'settingsController', 'credentialsController', 'agentDefaultModel', 'credentials', 'launchEnvironment', 'attachments']
  readonly drafts = new DraftStore()
  private readonly moving = new Set<string>()
  private readonly holds = new Map<string, () => void>()
  private readonly returning = new Set<string>()
  private readonly opening = new Map<string, Promise<{ url: string }>>()

  constructor(ctx: Context) {
    super(ctx, 'blaxelCloud')
    ctx.on('agent/request', async ({ agent, signal }, next) => {
      if (this.moving.has(agent.id)) {
        agent.cancel({ kind: 'hook', reason: 'Moving this session to Blaxel' }, { keepInbox: true })
        signal.throwIfAborted()
      }
      if (this.blocks(agent.id)) throw new Error('This session is owned by its Blaxel cloud host')
      return await next()
    })
    ctx.effect(() => () => {
      for (const release of this.holds.values()) release()
      this.holds.clear()
    })
  }

  blocks(sessionId: string): boolean {
    const visited = new Set<string>()
    let id: string | undefined = sessionId
    while (id !== undefined && !visited.has(id)) {
      if (this.moving.has(id) || this.ctx.blaxelSessions.cloudOwner(id) !== undefined) return true
      visited.add(id)
      id = this.ctx.sessions.get(SessionId(id))?.header.parentSession
    }
    return false
  }

  private async agent(sessionId: string): Promise<Agent> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId)
    if ('error' in result) throw new Error(result.error.message)
    return result.agent as Agent
  }

  private hold(agent: Agent): void {
    if (this.holds.has(agent.id)) return
    const hold = new Promise<void>(resolve => { this.holds.set(agent.id, resolve) })
    void agent.runMaintenance(async () => await hold).catch(() => undefined)
  }

  private release(sessionId: string): void {
    this.holds.get(sessionId)?.()
    this.holds.delete(sessionId)
    this.moving.delete(sessionId)
  }

  async move(sessionId: string, cwd: string, localOrigin: string, title?: string): Promise<{ sessionId: string; url: string }> {
    if (this.blocks(sessionId)) throw new Error('This session is already moving or running on Blaxel')
    if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(localOrigin)) throw new Error('The originating DSH address must be a local browser origin')
    const wasRunning = this.ctx.agents.get(SessionId(sessionId))?.status === 'running'
    this.moving.add(sessionId)
    let prepared: Awaited<ReturnType<typeof this.ctx.blaxelSessions.prepare>> | undefined
    let bound = false
    try {
      const model = await cloudModel(this.ctx, sessionId)
      const agent = await this.agent(sessionId)
      if (typeof agent.session.appendImported !== 'function') throw new Error('Start this profile with dsh-blaxel web to enable cloud session handoff with preserved timestamps')
      const continueTask = wasRunning || agent.status === 'running'
      // An active tool is allowed to settle; the request hook stops the next model step.
      await agent.whenIdle()
      this.hold(agent)
      await this.ctx.sessions.flush(agent.session)
      const session = inspect(agent.session)
      const related = await relatedSessions(this.ctx, sessionId)
      const images = await exportImages(this.ctx.attachments, [session, ...related])
      const draft = await this.drafts.get(sessionId)
      requireTransferSize({ session, related, images, draft, continueTask })
      prepared = await this.ctx.blaxelSessions.prepare(cwd, 'move', true)
      const remoteRelated = related.map(item => relocateSession(item, prepared!.snapshot.repoRoot, prepared!.runtime.workspaceRoot))
      const cloud: CloudBinding = {
        phase: 'preparing', controlToken: randomBytes(32).toString('hex'),
        initialSeq: session.events.length, initialHash: sessionPrefixHash(session.events), localOrigin, continueTask,
        related: related.map(item => ({ id: item.meta.id, seq: item.events.length, hash: sessionPrefixHash(item.events) })),
      }
      if (sessionPrefixHash(agent.session.snapshotEvents()) !== cloud.initialHash) throw new Error('New local input arrived during handoff. Retry to include it.')
      const remote = await this.ctx.blaxelSessions.bind(prepared, sessionId, title, cloud)
      prepared = undefined
      bound = true
      this.ctx.blaxelSessions.cloudProgress('host')
      await bootCloudHost(await remote.runtime.getSandbox(), {
        session: { ...session, meta: { ...session.meta, cwd: remote.runtime.cwd } },
        localOrigin, sandboxName: remote.runtime.name, workspace: remote.workspace, images, related: remoteRelated,
        draft,
        ...(continueTask ? { continuation: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue the task that was in progress before this session moved to Blaxel. The conversation and current project files have moved with you. Complete the remaining work and verify the result.' }] }) } : {}),
      }, model.settings, { ...model.env, DSH_BLAXEL_CONTROL_TOKEN: cloud.controlToken })
      const sandbox = await remote.runtime.getSandbox()
      await waitForCloudHost(sandbox, cloud.controlToken)
      await cloudRequest(sandbox, cloud.controlToken, 'start')
      this.ctx.blaxelSessions.updateCloud(sessionId, { ...cloud, phase: 'remote' })
      const result = await cloudRequest(sandbox, cloud.controlToken, 'open')
      if (typeof result.url !== 'string') throw new Error('The cloud session did not provide its browser address')
      this.ctx.blaxelSessions.cloudProgress('ready')
      return { sessionId, url: result.url }
    } catch (error) {
      if (prepared !== undefined) await this.ctx.blaxelSessions.discard(prepared)
      if (!bound) this.release(sessionId)
      else this.ctx.blaxelSessions.cloudProgress('host', error instanceof Error ? error.message : 'Cloud setup failed')
      throw new Error(`${error instanceof Error ? error.message : 'Cloud handoff failed'}${bound ? '. The sandbox and local conversation were retained. Reconnect before continuing.' : ''}`)
    } finally { this.moving.delete(sessionId) }
  }

  async open(sessionId: string): Promise<{ url: string }> {
    const pending = this.opening.get(sessionId)
    if (pending !== undefined) return await pending
    const opening = this.reopen(sessionId)
    this.opening.set(sessionId, opening)
    try { return await opening } finally { this.opening.delete(sessionId) }
  }

  private async reopen(sessionId: string): Promise<{ url: string }> {
    if (this.moving.has(sessionId)) throw new Error('The cloud session is still being prepared')
    if (await this.ctx.blaxelSessions.reconnect(sessionId) === 'missing') throw new Error('This cloud sandbox no longer exists. Its remote work cannot be recovered; use Continue locally to retain the original conversation.')
    const binding = this.ctx.blaxelSessions.binding(sessionId)
    const remote = this.ctx.blaxelSessions.get(sessionId)
    if (!binding?.cloud || !remote) throw new Error('Reconnect the cloud sandbox before opening the session')
    const sandbox = await remote.runtime.getSandbox()
    let running = false
    try { running = (await sandbox.process.get('dsh-cloud-host')).status === 'running' } catch (error) {
      if (!(error instanceof Error) || !/status 404: process not found/.test(error.message)) throw error
    }
    if (!running) {
      const model = await cloudModel(this.ctx, sessionId)
      const agent = await this.agent(sessionId)
      this.hold(agent)
      const session = inspect(agent.session)
      const related = await relatedSessions(this.ctx, sessionId)
      const images = await exportImages(this.ctx.attachments, [session, ...related])
      await bootCloudHost(sandbox, {
        session: { ...session, meta: { ...session.meta, cwd: remote.runtime.cwd } },
        localOrigin: binding.cloud.localOrigin, sandboxName: binding.sandboxName, workspace: binding.workspace, images,
        draft: await this.drafts.get(sessionId),
        related: related.map(item => relocateSession(item, binding.sourceRoot, binding.workspaceRoot)),
        ...(binding.cloud.continueTask ? { continuation: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue the task that was in progress before this session moved to Blaxel. Complete the remaining work and verify the result.' }] }) } : {}),
      }, model.settings, { ...model.env, DSH_BLAXEL_CONTROL_TOKEN: binding.cloud.controlToken })
    }
    await waitForCloudHost(sandbox, binding.cloud.controlToken)
    if (binding.cloud.phase === 'preparing') {
      await cloudRequest(sandbox, binding.cloud.controlToken, 'start')
      this.ctx.blaxelSessions.updateCloud(sessionId, { ...binding.cloud, phase: 'remote' })
    }
    const result = await cloudRequest(sandbox, binding.cloud.controlToken, 'open')
    if (typeof result.url !== 'string') throw new Error('The cloud session did not provide its browser address')
    return { url: result.url }
  }

  async review(sessionId: string): Promise<Record<string, unknown>> {
    const remote = this.ctx.blaxelSessions.get(sessionId)
    if (!remote) throw new Error('Reconnect the sandbox before reviewing its changes')
    const reader = divergenceReader(remote.runtime)
    const report = await reader.read()
    if (!report.available) throw new Error(report.reason)
    const patch = await reader.patch()
    if (patch.truncated) throw new Error('The changes exceed the automatic 1 MiB patch limit')
    return { divergence: report.divergence, patch: patch.text, reviewHash: createHash('sha256').update(patch.text).digest('hex') }
  }

  private receiptPath(sessionId: string): string {
    return join(dirname(defaultBindingStorePath()), 'blaxel-returns', createHash('sha256').update(sessionId).digest('hex') + '.json')
  }

  private async finishReturn(sessionId: string, receipt: { sandboxName: string; result: Record<string, unknown>; continuation?: ReturnType<typeof createUserMessage> }): Promise<Record<string, unknown>> {
    await this.ctx.blaxelSessions.close(sessionId)
    this.release(sessionId)
    if (receipt.continuation !== undefined) {
      const agent = await this.agent(sessionId)
      const message = receipt.continuation
      const queued = agent.session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced' && event.data.inserted.some(item => item.id === message.id))
      if (!queued) agent.followup(message)
      await this.ctx.sessions.flush(agent.session)
    }
    return receipt.result
  }

  async returnLocal(sessionId: string, reviewHash: string): Promise<Record<string, unknown>> {
    if (this.returning.has(sessionId)) throw new Error('This session is already moving back to local')
    const binding = this.ctx.blaxelSessions.binding(sessionId)
    const remote = this.ctx.blaxelSessions.get(sessionId)
    try {
      const receipt = JSON.parse(await readFile(this.receiptPath(sessionId), 'utf8')) as { sandboxName: string; result: Record<string, unknown>; continuation?: ReturnType<typeof createUserMessage> }
      if (binding === undefined || binding.sandboxName === receipt.sandboxName) {
        if (this.returning.has(sessionId)) throw new Error('This session is already moving back to local')
        this.returning.add(sessionId)
        try { return await this.finishReturn(sessionId, receipt) } finally { this.returning.delete(sessionId) }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (!binding?.cloud || !remote) throw new Error('Reconnect the cloud session before returning it')
    if (this.returning.has(sessionId)) throw new Error('This session is already moving back to local')
    this.returning.add(sessionId)
    let sandbox: Awaited<ReturnType<typeof remote.runtime.getSandbox>> | undefined
    let applied = false
    let frozenSuccessfully = false
    try {
      sandbox = await remote.runtime.getSandbox()
      const frozen = await cloudRequest(sandbox, binding.cloud.controlToken, 'freeze')
      frozenSuccessfully = true
      const remoteTranscript = validateSessionTransfer(frozen.session, sessionId)
      const related = validateRelated(sessionId, frozen.related)
      const agent = this.ctx.agents.get(SessionId(sessionId))
      if (agent !== undefined) this.hold(agent)
      const local = agent === undefined ? validateSessionTransfer(await this.ctx.sessionPersistence.inspect(SessionId(sessionId)), sessionId) : inspect(agent.session)
      const transcript = withLocalPermissions(remoteTranscript, local.events.slice(0, binding.cloud.initialSeq))
      if (sessionPrefixHash(local.events, binding.cloud.initialSeq) !== binding.cloud.initialHash
        || sessionPrefixHash(transcript.events, local.events.length) !== sessionPrefixHash(local.events)) {
        throw new Error('The local conversation changed after handoff. Both copies were preserved; nothing was applied.')
      }
      const childImports: Array<{ remote: SessionInspection; local?: SessionInspection }> = []
      const checkpoints = new Map(binding.cloud.related?.map(item => [item.id, item]) ?? [])
      const localHeaders = new Map((await this.ctx.sessionPersistence.list()).map(item => [item.id, item]))
      for (const remoteChild of related) {
        const child = withLocalPermissions(remoteChild, remoteChild.events.slice(0, checkpoints.get(remoteChild.meta.id)?.seq ?? 0).length > 0
          ? remoteChild.events.slice(0, checkpoints.get(remoteChild.meta.id)!.seq)
          : local.events.slice(0, binding.cloud.initialSeq))
        const checkpoint = checkpoints.get(child.meta.id)
        const localChild = localHeaders.has(child.meta.id) ? await this.ctx.sessionPersistence.inspect(child.meta.id) : undefined
        if (checkpoint === undefined && localChild !== undefined) {
          // A prior partial return may already have durably imported a new child.
          if (localChild.events.length > child.events.length || sessionPrefixHash(localChild.events) !== sessionPrefixHash(child.events, localChild.events.length)) throw new Error('A child conversation conflicts with a local session; both were preserved')
        } else if (checkpoint !== undefined && (localChild === undefined || localChild.events.length < checkpoint.seq
          || sessionPrefixHash(localChild.events, checkpoint.seq) !== checkpoint.hash
          || sessionPrefixHash(child.events, localChild.events.length) !== sessionPrefixHash(localChild.events))) {
          throw new Error('A local child conversation changed after handoff; both copies were preserved')
        }
        childImports.push({ remote: relocateSession(child, binding.workspaceRoot, binding.sourceRoot), local: localChild })
      }
      if ([...checkpoints.keys()].some(id => !related.some(child => child.meta.id === id))) throw new Error('A child conversation is missing from the cloud transfer')
      const reader = divergenceReader(remote.runtime)
      const report = await reader.read()
      if (!report.available) throw new Error(report.reason)
      const patch = await reader.patch()
      if (createHash('sha256').update(patch.text).digest('hex') !== reviewHash) throw new Error('The sandbox changed after your review. Review the latest changes before applying them.')
      this.ctx.blaxelSessions.updateCloud(sessionId, { ...binding.cloud, phase: 'returning' })
      await importImages(this.ctx.attachments, [transcript, ...related], frozen.images as TransferImage[] | undefined)
      await applySandboxPatch(binding.sourceRoot, patch)
      applied = true
      const importedEvents = transcript.events.length - local.events.length
      if (agent !== undefined) {
        importSessionTail(agent.session, transcript, binding.cloud.initialSeq, binding.cloud.initialHash)
        await this.ctx.sessions.flush(agent.session)
      } else {
        await this.ctx.sessionPersistence.append(SessionId(sessionId), transcript.events.slice(local.events.length))
      }
      for (const child of childImports) {
        const live = this.ctx.sessions.get(child.remote.meta.id)
        if (live !== undefined) {
          const checkpoint = checkpoints.get(child.remote.meta.id)
          importSessionTail(live, child.remote, checkpoint?.seq ?? child.local!.events.length, checkpoint?.hash ?? sessionPrefixHash(child.local!.events))
          await this.ctx.sessions.flush(live)
        } else {
          if (child.local === undefined) await this.ctx.sessionPersistence.create(child.remote.meta, child.remote.inheritedEventCount)
          await this.ctx.sessionPersistence.append(child.remote.meta.id, child.remote.events.slice(child.local?.events.length ?? 0))
        }
      }
      if (childImports.length > 0) {
        const imported = new Set(childImports.map(child => child.remote.meta.id))
        const summaries = await this.ctx.sessionController.list({}, new AbortController().signal)
        for (const summary of summaries.items) if (imported.has(SessionId(summary.sessionId))) this.ctx.emit('api-session/added', summary)
      }
      if (frozen.draft !== undefined) await this.drafts.save(sessionId, (frozen.draft as import('./cloud/draft.js').SavedDraft).draft)
      const receipt = { sandboxName: binding.sandboxName, result: { divergence: report.divergence, repoRoot: binding.sourceRoot, importedEvents },
        ...(frozen.continueTask === true ? { continuation: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue the task that was in progress before this session returned from Blaxel. Your conversation and reviewed project changes are back on this computer. Complete the remaining work and verify it.' }] }) } : {}) }
      await writePrivateJson(this.receiptPath(sessionId), receipt)
      return await this.finishReturn(sessionId, receipt)
    } catch (error) {
      if (!applied && frozenSuccessfully && sandbox !== undefined) {
        await cloudRequest(sandbox, binding.cloud.controlToken, 'release').then(() => {
          this.ctx.blaxelSessions.updateCloud(sessionId, { ...binding.cloud!, phase: 'remote' })
        }).catch(() => undefined)
      }
      throw error
    } finally { this.returning.delete(sessionId) }
  }

  async discard(sessionId: string): Promise<void> {
    await this.ctx.blaxelSessions.close(sessionId)
    this.release(sessionId)
  }
}
