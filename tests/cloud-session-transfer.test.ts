import '@deepseek-ai/dsh-sandbox-policy'
import '@deepseek-ai/dsh-user-approval'
import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { importSessionTail, remainingSeedEvents, sessionPrefixHash, validateSessionTransfer, withLocalPermissions } from '../src/cloud/session-transfer.js'
import { MAX_TRANSFER_BYTES, requireTransferSize } from '../src/cloud/attachments.js'
import { descendantHeaders, relocateSession, validateRelated } from '../src/cloud/related-sessions.js'
import { addressedSessions } from '../src/cloud-gateway.js'

function snapshot(session: Session) {
  return { meta: session.header, inheritedEventCount: session.inheritedEventCount, events: session.snapshotEvents() }
}

function message(session: Session, text: string) {
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
}

describe('native cloud conversation transfer', () => {
  it('recovers empty and partially appended root and child seeds without replacing later cloud work', () => {
    const root = Session.create(SessionId('seed-root'))
    const child = Session.create(SessionId('seed-child'), undefined, { ...root.header, id: SessionId('seed-child'), parentSession: root.id })
    for (const session of [root, child]) {
      message(session, 'First part')
      message(session, 'Second part')
      const seed = snapshot(session)
      for (const count of [0, 1, seed.events.length]) {
        const stored = { ...seed, events: seed.events.slice(0, count) }
        stored.events.push(...remainingSeedEvents(seed, stored))
        expect(stored.events).toEqual(seed.events)
        expect(remainingSeedEvents(seed, stored)).toEqual([])
      }
      message(session, 'Later cloud result')
      expect(remainingSeedEvents(seed, snapshot(session))).toEqual([])
      const different = { ...structuredClone(seed), events: [...structuredClone(seed.events)] }
      different.events[0] = { ...different.events[0], data: { ...different.events[0].data, id: 'different-message' } } as never
      expect(() => remainingSeedEvents(seed, different)).toThrow()
    }
  })

  it('counts pending drafts with history and images before handoff and reserves response overhead', () => {
    const transfer = { session: 's'.repeat(16 * 1024 * 1024 - 1024), images: ['i'.repeat(40 * 1024 * 1024)], draft: { text: '', images: ['d'.repeat(9 * 1024 * 1024)] } }
    expect(() => requireTransferSize({ ...transfer, draft: undefined })).not.toThrow()
    expect(() => requireTransferSize(transfer)).toThrow('64 MiB')
    expect(() => requireTransferSize('x'.repeat(MAX_TRANSFER_BYTES - 4098))).not.toThrow()
    expect(() => requireTransferSize('x'.repeat(MAX_TRANSFER_BYTES - 4097))).toThrow('64 MiB')
  })

  it('preserves every imported event timestamp and rejects invalid envelopes before publication', () => {
    const local = Session.create(SessionId('original-times'))
    message(local, 'Original local task')
    const initial = snapshot(local)
    const remote = Session.fromRestore(local.id, structuredClone(initial.events), structuredClone(initial.meta), initial.inheritedEventCount)
    message(remote, 'Finished remotely')
    const transferred = snapshot(remote)
    transferred.events = transferred.events.map((event, index) => index === 0 ? event : { ...event, time: 1700000000000 + index })
    importSessionTail(local, transferred, initial.events.length, sessionPrefixHash(initial.events))
    expect(local.snapshotEvents()).toEqual(transferred.events)
    const before = local.snapshotEvents()
    expect(() => local.appendImported({ ...before[0], seq: local.seq, time: NaN } as never)).toThrow()
    expect(() => local.appendImported({ ...before[0], seq: 999 } as never)).toThrow()
    expect(local.snapshotEvents()).toEqual(before)
  })
  it('retains existing context and imports the cloud tail exactly once', () => {
    const local = Session.create(SessionId('roundtrip'))
    message(local, 'Sort the invoices newest first')
    const initial = snapshot(local)
    const remote = Session.fromRestore(local.id, structuredClone(initial.events), structuredClone(initial.meta), initial.inheritedEventCount)
    message(remote, 'The sandbox implementation passed its tests')
    const hash = sessionPrefixHash(initial.events)
    expect(importSessionTail(local, snapshot(remote), 1, hash)).toBe(2)
    expect(importSessionTail(local, snapshot(remote), 1, hash)).toBe(0)
    expect(sessionPrefixHash(local.snapshotEvents())).toBe(sessionPrefixHash(remote.snapshotEvents()))
  })

  it('refuses divergent local input before changing either conversation', () => {
    const local = Session.create(SessionId('conflict'))
    message(local, 'Original task')
    const initial = snapshot(local)
    const remote = Session.fromRestore(local.id, structuredClone(initial.events), structuredClone(initial.meta), initial.inheritedEventCount)
    message(local, 'A competing local request')
    message(remote, 'Cloud result')
    const before = snapshot(local)
    expect(() => importSessionTail(local, snapshot(remote), 1, sessionPrefixHash(initial.events))).toThrow('local conversation changed')
    expect(snapshot(local)).toEqual(before)
  })

  it('rejects a different identity and a corrupt sequence before import', () => {
    const local = Session.create(SessionId('protected'))
    message(local, 'Keep this task')
    expect(() => validateSessionTransfer(snapshot(local), 'another-session')).toThrow('identity')
    const invalid = { ...structuredClone(snapshot(local)), events: [...structuredClone(local.snapshotEvents())] }
    invalid.events[0] = { ...invalid.events[0], seq: 12 } as never
    expect(() => validateSessionTransfer(invalid, local.id)).toThrow()
    expect(local.snapshotEvents()).toHaveLength(1)
  })

  it('recognizes direct and nested API identities without scanning prompt text', () => {
    expect(addressedSessions({ request: { sessionId: 'session-a' }, agentId: 'session-b', content: [{ sessionId: 'quoted-text' }] })).toEqual(['session-a', 'session-b'])
  })

  it('restores laptop permissions and retries a partially completed return without duplication', () => {
    const local = Session.create(SessionId('permissions'))
    local.append('sandbox/mode', { mode: 'workspace-write' })
    local.append('approval/policy', { policy: 'ask' })
    const initial = snapshot(local)
    const remote = Session.fromRestore(local.id, structuredClone(initial.events), structuredClone(initial.meta), initial.inheritedEventCount)
    remote.append('sandbox/mode', { mode: 'danger-full-access' })
    remote.append('approval/policy', { policy: 'never' })
    message(remote, 'Completed in the cloud')
    const target = withLocalPermissions(snapshot(remote), initial.events)
    importSessionTail(local, target, initial.events.length, sessionPrefixHash(initial.events))
    expect(local.snapshotEvents().filter(event => event.type === 'sandbox/mode').at(-1)?.data).toEqual({ mode: 'workspace-write' })
    expect(importSessionTail(local, withLocalPermissions(snapshot(remote), initial.events), initial.events.length, sessionPrefixHash(initial.events))).toBe(0)
  })

  it('restores implicit laptop defaults and rejects uncaptured cloud permissions', () => {
    const local = Session.create(SessionId('implicit-permissions'))
    message(local, 'A session using deployment defaults')
    const initial = snapshot(local)
    const remote = Session.fromRestore(local.id, structuredClone(initial.events), initial.meta, initial.inheritedEventCount)
    remote.append('sandbox/mode', { mode: 'danger-full-access' })
    remote.append('approval/policy', { policy: 'never' })
    expect(() => withLocalPermissions(snapshot(remote), initial.events)).toThrow('not captured')
    for (const sandbox of ['read-only', 'workspace-write'] as const) {
      const defaults = { sandbox, approval: 'ask' as const }
      const target = withLocalPermissions(snapshot(remote), initial.events, defaults)
      expect(target.events.filter(event => event.type === 'sandbox/mode').at(-1)?.data).toEqual({ mode: sandbox })
      expect(target.events.filter(event => event.type === 'approval/policy').at(-1)?.data).toEqual({ policy: 'ask' })
      expect(sessionPrefixHash(withLocalPermissions(snapshot(remote), [], defaults).events)).toBe(sessionPrefixHash(target.events))
    }
    const defaults = { sandbox: 'workspace-write' as const, approval: 'ask' as const }
    const target = withLocalPermissions(snapshot(remote), initial.events, defaults)
    importSessionTail(local, target, initial.events.length, sessionPrefixHash(initial.events))
    expect(importSessionTail(local, withLocalPermissions(snapshot(remote), initial.events, defaults), initial.events.length, sessionPrefixHash(initial.events))).toBe(0)
  })

  it('transfers child history and relocates only paths within the selected project', () => {
    const root = Session.create(SessionId('root'), undefined, { version: 0, id: SessionId('root'), createdAt: 1, cwd: '/project', isSeeded: false })
    const child = Session.create(SessionId('child'), undefined, { ...root.header, id: SessionId('child'), parentSession: root.id, cwd: '/project/subdir' })
    const other = Session.create(SessionId('unrelated'))
    expect(descendantHeaders(root.id, [child.header, other.header]).map(header => header.id)).toEqual(['child'])
    expect(relocateSession(snapshot(child), '/project', '/workspace').meta.cwd).toBe('/workspace/subdir')
    expect(() => relocateSession(snapshot(child), '/elsewhere', '/workspace')).toThrow('outside this project')
    expect(validateRelated(root.id, [snapshot(child)])).toHaveLength(1)
    expect(() => validateRelated(root.id, [snapshot(other)])).toThrow('unrelated')
  })
})
