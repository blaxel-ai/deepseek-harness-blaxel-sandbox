import { FileSystem } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { sandboxRoutingSession } from '../session-runtime/routing-session.js'

/** Selects the filesystem backend by the session driving the current tool call. */
export class RoutingFileSystem extends FileSystem {
  constructor(ctx: Context, private readonly local: FileSystem) {
    super(ctx)
  }

  private backend(): FileSystem {
    const sessionId = sandboxRoutingSession(this.ctx.agents, this.ctx.blaxelSessions, this.ctx.agents.currentInitiator())
    const remote = this.ctx.blaxelSessions.get(sessionId)
    if (remote !== undefined) return remote.fs
    if (this.ctx.blaxelSessions.isSandboxSession(sessionId)) throw new Error('This session is still bound to an unavailable Blaxel sandbox. Local tools are blocked; reconnect, or continue locally to drop the sandbox.')
    return this.local
  }

  override get sandboxMode() { return this.local.sandboxMode }
  override resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }) { return this.backend().resolve(path, opts) }
  override processPath(target: FsTarget) { return this.backend().processPath(target) }
  override fileUrl(target: FsTarget) { return this.backend().fileUrl(target) }
  override contains(parent: FsTarget, child: FsTarget) { return this.backend().contains(parent, child) }
  override stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> { return this.backend().stat(target, signal) }
  override lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> { return this.backend().lstat(path, opts, signal) }
  override readText(target: FsTarget, signal?: AbortSignal) { return this.backend().readText(target, signal) }
  override streamText(target: FsTarget, signal?: AbortSignal) { return this.backend().streamText(target, signal) }
  override readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number) { return this.backend().readBytes(target, signal, maxBytes) }
  override listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> { return this.backend().listDir(target, signal) }
  override writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, policy?: SandboxExecutionPolicy): Promise<FsWriteOutcome> {
    return this.backend().writeText(target, content, expected, signal, policy)
  }
  override editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal, policy?: SandboxExecutionPolicy): Promise<FsEditOutcome> {
    return this.backend().editText(target, edit, expected, signal, policy)
  }
}
