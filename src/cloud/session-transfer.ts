import { createHash } from 'node:crypto'
import { Session, SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-permission-presets'

export const MAX_SESSION_BYTES = 16 * 1024 * 1024
export const MAX_SESSION_EVENTS = 100_000

export interface LocalPermissions {
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
  approval: 'ask' | 'never'
  preset?: string
}

export function validLocalPermissions(value: unknown): value is LocalPermissions {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Partial<LocalPermissions>
  return ['read-only', 'workspace-write', 'danger-full-access'].includes(item.sandbox ?? '') && ['ask', 'never'].includes(item.approval ?? '')
    && (item.preset === undefined || (typeof item.preset === 'string' && item.preset.length > 0 && item.preset.length <= 200))
}

export function localPermissions(ctx: Context, session: Session): LocalPermissions {
  const preset = ctx.permissionPresets.current(session)
  return { sandbox: ctx.sandboxPolicy.resolve({ session }).mode, approval: ctx.approval.overrideOf(session) ?? ctx.approval.config.policy ?? 'ask', ...(preset === 'custom' ? {} : { preset }) }
}

/** Transport the native log; never reconstruct a conversation from rendered chat text. */
export function validateSessionTransfer(value: unknown, expectedId: string): SessionInspection {
  if (typeof value !== 'object' || value === null) throw new Error('The session transfer is invalid')
  const input = value as SessionInspection
  if (input.meta?.id !== expectedId || !Array.isArray(input.events)) throw new Error('The session transfer identity does not match')
  if (input.events.length > MAX_SESSION_EVENTS || Buffer.byteLength(JSON.stringify(input)) > MAX_SESSION_BYTES) {
    throw new Error('This conversation exceeds the 16 MiB cloud handoff limit')
  }
  const restored = Session.fromRestore(SessionId(expectedId), structuredClone(input.events), structuredClone(input.meta), SessionLogOffset(input.inheritedEventCount))
  // fromRestore adds its own live resume boundary. Validation must not change the transfer.
  return { meta: restored.header, inheritedEventCount: restored.inheritedEventCount, events: restored.snapshotEvents(SessionLogOffset(0), SessionLogOffset(input.events.length)) }
}

/** Ignore import time, while checking every sequence, payload and surface reference. */
export function sessionPrefixHash(events: readonly SessionEvent[], count = events.length): string {
  const hash = createHash('sha256')
  for (const event of events.slice(0, count)) {
    const { time: _time, ...record } = event
    hash.update(JSON.stringify(record)).update('\n')
  }
  return hash.digest('hex')
}

/** Resume a seed interrupted after create or append, preserving any later cloud work. */
export function remainingSeedEvents(seed: SessionInspection, stored: SessionInspection): SessionEvent[] {
  const existing = validateSessionTransfer(stored, seed.meta.id)
  const count = Math.min(seed.events.length, existing.events.length)
  if (sessionPrefixHash(seed.events, count) !== sessionPrefixHash(existing.events, count)) {
    throw new Error('The saved cloud conversation diverged from its handoff seed; both copies were preserved')
  }
  return seed.events.slice(existing.events.length)
}

/** Cloud VM permissions must never become the returning laptop's permissions. */
export function withLocalPermissions(remote: SessionInspection, original: readonly SessionEvent[], fallback?: LocalPermissions): SessionInspection {
  if (fallback !== undefined && !validLocalPermissions(fallback)) throw new Error('The saved local permissions are invalid; both copies were preserved')
  const types = ['permission/preset', 'sandbox/mode', 'approval/policy'] as const
  const events = [...remote.events]
  const defaults = {
    'permission/preset': fallback?.preset === undefined ? undefined : { preset: fallback.preset },
    'sandbox/mode': fallback === undefined ? undefined : { mode: fallback.sandbox },
    'approval/policy': fallback === undefined ? undefined : { policy: fallback.approval },
  }
  for (const type of types) {
    const before = original.findLast(event => event.type === type)
    const current = events.findLast(event => event.type === type)
    const data = before?.data ?? defaults[type]
    if (data === undefined && current !== undefined && type !== 'permission/preset') throw new Error('The original laptop permissions were not captured. Both copies were preserved; restore local permissions before retrying this return.')
    if (data !== undefined && JSON.stringify(data) !== JSON.stringify(current?.data)) {
      events.push({ type, seq: events.length, time: Date.now(), data } as SessionEvent)
    }
  }
  return validateSessionTransfer({ ...remote, events }, remote.meta.id)
}

/** Validate the complete tail before touching the live log; retries skip already imported events. */
export function importSessionTail(local: Session, remote: SessionInspection, initialSeq: number, initialHash: string): number {
  const checked = validateSessionTransfer(remote, local.id)
  const existing = local.snapshotEvents()
  if (existing.length < initialSeq || checked.events.length < existing.length
    || sessionPrefixHash(existing, initialSeq) !== initialHash
    || sessionPrefixHash(checked.events, existing.length) !== sessionPrefixHash(existing)) {
    throw new Error('The local conversation changed after handoff. Both conversations have been preserved; nothing was imported.')
  }
  // A detached native Session validates all surface dependencies before publication starts.
  Session.fromRestore(local.id, structuredClone(checked.events), structuredClone(local.header), local.inheritedEventCount)
  if (typeof local.appendImported !== 'function') throw new Error('Cloud session return needs native history import support. Restart this profile with dsh-blaxel web; both copies are preserved.')
  for (const event of checked.events.slice(existing.length)) local.appendImported(event)
  return checked.events.length - existing.length
}
