import type { Context } from '@deepseek-ai/cordis'
import { isAbsolute, relative, resolve } from 'node:path'
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import { MAX_SESSION_BYTES, validateSessionTransfer, type LocalPermissions } from './session-transfer.js'

export interface SessionCheckpoint { id: string; seq: number; hash: string; permissions?: LocalPermissions }
const MAX_RELATED = 32

/** Include descendants only, never siblings or unrelated conversations from the profile. */
export function descendantHeaders(root: string, headers: readonly SessionHeader[]): SessionHeader[] {
  const children = new Map<string, SessionHeader[]>()
  for (const header of headers) {
    if (header.parentSession === undefined) continue
    const group = children.get(header.parentSession) ?? []
    group.push(header)
    children.set(header.parentSession, group)
  }
  const result: SessionHeader[] = []
  const seen = new Set([root])
  const queue = [root]
  for (let cursor = 0; cursor < queue.length; cursor++) {
    for (const header of children.get(queue[cursor]) ?? []) {
      if (seen.has(header.id)) throw new Error('The session hierarchy contains a cycle')
      seen.add(header.id)
      result.push(header)
      queue.push(header.id)
      if (result.length > MAX_RELATED) throw new Error('This conversation exceeds the 32-child-session handoff limit')
    }
  }
  return result
}

export async function relatedSessions(ctx: Context, root: string): Promise<SessionInspection[]> {
  const headers = new Map((await ctx.sessionPersistence.list()).map(header => [header.id, header]))
  for (const session of ctx.sessions.list()) headers.set(session.id, session.header)
  const result: SessionInspection[] = []
  let bytes = 0
  for (const header of descendantHeaders(root, [...headers.values()])) {
    const agent = ctx.agents.get(header.id)
    if (agent?.status === 'running') throw new Error('A child agent is still working. Wait for it to finish before moving this session.')
    if (agent !== undefined) await ctx.sessions.flush(agent.session)
    const session = validateSessionTransfer(await ctx.sessionPersistence.inspect(SessionId(header.id)), header.id)
    bytes += Buffer.byteLength(JSON.stringify(session))
    if (bytes > MAX_SESSION_BYTES) throw new Error('Child-session history exceeds the 16 MiB handoff limit')
    result.push(session)
  }
  return result
}

export function validateRelated(root: string, value: unknown): SessionInspection[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_RELATED || Buffer.byteLength(JSON.stringify(value)) > MAX_SESSION_BYTES) throw new Error('The child-session transfer exceeds its limit')
  const sessions = value.map(item => validateSessionTransfer(item, (item as SessionInspection).meta?.id))
  if (new Set(sessions.map(item => item.meta.id)).size !== sessions.length || descendantHeaders(root, sessions.map(item => item.meta)).length !== sessions.length) throw new Error('The transfer contains an unrelated child session')
  return sessions
}

export function relocateSession(session: SessionInspection, source: string, destination: string): SessionInspection {
  const suffix = relative(source, session.meta.cwd ?? source)
  if (suffix === '..' || suffix.startsWith('../') || isAbsolute(suffix)) throw new Error('A child session uses files outside this project; move it separately before handing off this conversation')
  return { ...session, meta: { ...session.meta, cwd: resolve(destination, suffix) } }
}
