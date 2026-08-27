import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessSpawnSpec, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'

/** Selects the process backend by the session driving the current tool call. */
export class RoutingSubprocessRuntime extends SubprocessRuntime {
  constructor(ctx: Context, private readonly local: SubprocessRuntime) {
    super(ctx)
  }

  private backend(): SubprocessRuntime {
    const sessionId = String(this.ctx.agents.currentInitiator()?.id ?? '') || undefined
    const remote = this.ctx.blaxelSessions.get(sessionId)
    if (remote !== undefined) return remote.subprocess
    if (this.ctx.blaxelSessions.isSandboxSession(sessionId)) throw new Error('This sandbox session is stopped; start a new sandbox session to continue')
    return this.local
  }

  override resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    return this.backend().resolveExecutable(command, env, signal)
  }
  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle { return this.backend().spawn(spec) }
  override spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> { return this.backend().spawnTerminal(spec) }
}
