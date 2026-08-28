import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { describe, expect, it } from 'vitest'
import { sandboxRoutingSession } from '../src/session-runtime/routing-session.js'

function agent(id: string): Agent {
  return { id } as unknown as Agent
}

describe('sandbox routing ownership', () => {
  it('inherits the sandbox backend through an in-process child-agent chain', () => {
    const root = agent('sandbox-session')
    const child = agent('child-session')
    const grandchild = agent('grandchild-session')
    const agents = {
      list: () => [root, child, grandchild],
      isOwnedBy: (id: string, owner: Agent) => (
        (id === child.id && owner === root) || (id === grandchild.id && owner === child)
      ),
    } as unknown as AgentRegistry

    expect(sandboxRoutingSession(
      agents,
      { isSandboxSession: sessionId => sessionId === root.id },
      grandchild,
    )).toBe(root.id)
  })

  it('leaves an unrelated local agent on local backends', () => {
    const local = agent('local-session')
    const agents = {
      list: () => [local],
      isOwnedBy: () => false,
    } as unknown as AgentRegistry

    expect(sandboxRoutingSession(agents, { isSandboxSession: () => false }, local)).toBeUndefined()
  })
})
