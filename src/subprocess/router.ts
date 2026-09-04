import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessSpawnSpec, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { sandboxRoutingSession } from '../session-runtime/routing-session.js'

/** Selects the process backend by the session driving the current tool call. */
export class RoutingSubprocessRuntime extends SubprocessRuntime {
  constructor(ctx: Context, private readonly local: SubprocessRuntime) {
    super(ctx)
  }

  private backend(): SubprocessRuntime {
    const sessionId = sandboxRoutingSession(this.ctx.agents, this.ctx.blaxelSessions, this.ctx.agents.currentInitiator())
    const remote = this.ctx.blaxelSessions.get(sessionId)
    if (remote !== undefined) return remote.subprocess
    if (this.ctx.blaxelSessions.isSandboxSession(sessionId)) throw new Error('This session is still bound to an unavailable Blaxel sandbox. Local tools are blocked; reconnect, or continue locally to drop the sandbox.')
    return this.local
  }

  override resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    return this.backend().resolveExecutable(command, env, signal)
  }
  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle { return this.backend().spawn(spec) }
  override spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> { return this.backend().spawnTerminal(spec) }
}
