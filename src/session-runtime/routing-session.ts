import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'

interface SandboxSessionLookup {
  isSandboxSession(sessionId: string | undefined): boolean
}

/** Resolves an initiating agent to its nearest sandbox-backed runtime owner. */
export function sandboxRoutingSession(
  agents: AgentRegistry,
  sessions: SandboxSessionLookup,
  initiator: Agent | undefined,
): string | undefined {
  let current = initiator
  const live = agents.list()
  const visited = new Set<string>()
  while (current !== undefined) {
    const sessionId = String(current.id)
    if (sessions.isSandboxSession(sessionId)) return sessionId
    if (visited.has(sessionId)) throw new Error('Agent ownership contains a cycle')
    visited.add(sessionId)
    const child = current
    current = live.find(candidate => agents.isOwnedBy(child.id, candidate))
  }
  return undefined
}
