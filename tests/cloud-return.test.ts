import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { sessionPrefixHash } from '../src/cloud/session-transfer.js'

const calls = vi.hoisted(() => ({ cloud: vi.fn(), apply: vi.fn(), reader: vi.fn() }))
vi.mock('../src/cloud/bootstrap.js', () => ({ cloudRequest: calls.cloud }))
vi.mock('../src/web/local-sync.js', () => ({ applySandboxPatch: calls.apply }))
vi.mock('../src/web/divergence.js', () => ({ divergenceReader: calls.reader }))
import BlaxelCloudHandoff from '../src/cloud.js'

const directories: string[] = []
afterEach(async () => { vi.resetAllMocks(); vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true }))) })
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'dsh-return-test-')); directories.push(path)
  vi.stubEnv('DSH_BLAXEL_BINDINGS_PATH', join(path, 'bindings.json'))
  const local = Session.create(SessionId('return-session'))
  local.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Original request' }] }), { surfaceOp: 'append' })
  const initial = local.snapshotEvents()
  const remote = Session.fromRestore(local.id, structuredClone(initial), structuredClone(local.header), local.inheritedEventCount)
  remote.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Cloud result' }] }), { surfaceOp: 'append' })
  const frozen = { session: { meta: remote.header, events: remote.snapshotEvents(), inheritedEventCount: remote.inheritedEventCount }, related: [] as SessionInspection[], images: [], continueTask: false }
  calls.cloud.mockImplementation(async (_sandbox, _token, command) => command === 'freeze' ? frozen : { released: true })
  calls.reader.mockReturnValue({ read: async () => ({ available: true, divergence: { changed: 1 } }), patch: async () => ({ text: 'patch', truncated: false }) })
  calls.apply.mockResolvedValue(undefined)
  const binding = { cloud: { phase: 'remote', initialSeq: initial.length, initialHash: sessionPrefixHash(initial), controlToken: 'test-only' }, sourceRoot: path, workspaceRoot: '/workspace', sandboxName: 'test-only' }
  const agent = { id: local.id, session: local, runMaintenance: async () => undefined }
  const close = vi.fn(async () => undefined), flush = vi.fn(async () => true), update = vi.fn()
  const stored = new Map<string, SessionInspection>([[local.id, { meta: local.header, events: [...initial], inheritedEventCount: local.inheritedEventCount }]])
  const append = vi.fn(async (id: string, events: SessionInspection['events']) => { const saved = stored.get(id)!; stored.set(id, { ...saved, events: [...saved.events, ...events] }) })
  const ctx = { emit: vi.fn(), agents: { get: (): typeof agent | undefined => agent }, sessionController: { list: async () => ({ items: [...stored.keys()].map(sessionId => ({ sessionId, running: false })) }), resolveAgent: vi.fn(async () => ({ agent })) }, sessions: { flush, get: (): Session | undefined => undefined }, sessionPersistence: {
    list: async () => [...stored.values()].map(item => item.meta),
    inspect: async (id: string) => structuredClone(stored.get(id)!),
    create: async (meta: SessionInspection['meta'], inheritedEventCount: SessionInspection['inheritedEventCount']) => { stored.set(meta.id, { meta, inheritedEventCount, events: [] }) }, append,
  }, attachments: {},
    blaxelSessions: { binding: () => binding, get: () => ({ runtime: { getSandbox: async () => ({}) } }), close, updateCloud: update } }
  // Exercise the transaction against native Session objects without starting unrelated host services.
  const service = Object.create(BlaxelCloudHandoff.prototype)
  Object.defineProperty(service, 'ctx', { value: ctx })
  Object.assign(service, { holds: new Map(), moving: new Set(), returning: new Set(), drafts: { save: vi.fn() } })
  return { service: service as BlaxelCloudHandoff, local, frozen, close, flush, update, ctx, stored, append, hash: createHash('sha256').update('patch').digest('hex') }
}

describe('cloud return recovery', () => {
  it('finishes a cold partial child import without resuming or duplicating the local root', async () => {
    const f = await fixture()
    f.ctx.agents.get = () => undefined
    const child = Session.create(SessionId('cloud-child'), undefined, { ...f.local.header, id: SessionId('cloud-child'), parentSession: f.local.id, cwd: '/workspace' })
    for (const text of ['Child review', 'Child result']) child.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
    const remote = { meta: child.header, inheritedEventCount: child.inheritedEventCount, events: child.snapshotEvents() }
    f.frozen.related.push(remote)
    f.stored.set(child.id, { ...remote, events: remote.events.slice(0, 1) })
    await f.service.returnLocal(f.local.id, f.hash)
    expect(f.stored.get(child.id)?.events).toEqual(remote.events)
    expect(f.stored.get(f.local.id)?.events).toEqual(f.frozen.session.events)
    expect(f.ctx.sessionController.resolveAgent).not.toHaveBeenCalled()
    expect(f.ctx.emit).toHaveBeenCalledWith('api-session/added', { sessionId: child.id, running: false })
    expect(f.close).toHaveBeenCalledOnce()
  })
  it('recovers a receipt after replacing all in-memory return state', async () => {
    const f = await fixture()
    f.close.mockRejectedValueOnce(new Error('cleanup interrupted'))
    await expect(f.service.returnLocal(f.local.id, f.hash)).rejects.toThrow('cleanup interrupted')
    const restarted = Object.create(BlaxelCloudHandoff.prototype)
    Object.defineProperty(restarted, 'ctx', { value: f.ctx })
    Object.assign(restarted, { holds: new Map(), moving: new Set(), returning: new Set() })
    await restarted.returnLocal(f.local.id, f.hash)
    expect(calls.apply).toHaveBeenCalledOnce()
    expect(calls.cloud).toHaveBeenCalledOnce()
    expect(f.local.snapshotEvents()).toEqual(f.frozen.session.events)
  })
  it('allows retry when retrieving the sandbox fails before freezing', async () => {
    const f = await fixture()
    const get = vi.spyOn(f.ctx.blaxelSessions, 'get')
    get.mockReturnValueOnce({ runtime: { getSandbox: async () => { throw new Error('temporary connection failure') } } })
    await expect(f.service.returnLocal(f.local.id, f.hash)).rejects.toThrow('temporary connection failure')
    await expect(f.service.returnLocal(f.local.id, f.hash)).resolves.toHaveProperty('importedEvents', 2)
  })
  it('retries cleanup from a durable receipt without importing or applying twice', async () => {
    const f = await fixture()
    f.close.mockRejectedValueOnce(new Error('provider temporarily unavailable'))
    await expect(f.service.returnLocal(f.local.id, f.hash)).rejects.toThrow('provider temporarily unavailable')
    expect(f.local.snapshotEvents()).toEqual(f.frozen.session.events)
    const result = await f.service.returnLocal(f.local.id, f.hash)
    expect(result.importedEvents).toBe(2)
    expect(calls.apply).toHaveBeenCalledTimes(1)
    expect(calls.cloud).toHaveBeenCalledTimes(1)
    expect(f.close).toHaveBeenCalledTimes(2)
  })
  it('retries a failed transcript flush and keeps cloud ownership until everything is durable', async () => {
    const f = await fixture()
    f.flush.mockRejectedValueOnce(new Error('temporary storage failure'))
    await expect(f.service.returnLocal(f.local.id, f.hash)).rejects.toThrow('temporary storage failure')
    expect(f.close).not.toHaveBeenCalled()
    expect(calls.cloud.mock.calls.every(call => call[2] === 'freeze')).toBe(true)
    await f.service.returnLocal(f.local.id, f.hash)
    expect(f.local.snapshotEvents()).toEqual(f.frozen.session.events)
    expect(f.close).toHaveBeenCalledTimes(1)
  })
  it('releases a conflicting return without changing local history or deleting cloud work', async () => {
    const f = await fixture()
    const before = f.local.snapshotEvents()
    calls.apply.mockRejectedValueOnce(new Error('Local files changed'))
    await expect(f.service.returnLocal(f.local.id, f.hash)).rejects.toThrow('Local files changed')
    expect(f.local.snapshotEvents()).toEqual(before)
    expect(f.close).not.toHaveBeenCalled()
    expect(calls.cloud.mock.calls.at(-1)?.[2]).toBe('release')
    expect(f.update.mock.calls.at(-1)?.[1].phase).toBe('remote')
  })
})
