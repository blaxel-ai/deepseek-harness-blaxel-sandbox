/** Blaxel implementation of DSH subprocess and terminal capability seams. */
import { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { shellQuote } from '../shared/shell.js'
import { environmentFor } from './environment.js'
import { BlaxelProcessHandle } from './process-handle.js'
import { BlaxelTerminal } from './terminal.js'


const MAX_TIMER_DELAY_MS = 2_147_483_647
const PACKAGED_RIPGREP = /(?:^|\/)@vscode\/ripgrep-[^/]+\/bin\/rg(?:\.exe)?$/

export function remoteExecutable(command: string): string {
  return PACKAGED_RIPGREP.test(command) ? 'rg' : command
}

/** Removes the host's macOS file-sandbox wrapper before execution in Linux. */
export function remoteArgv(argv: readonly string[]): string[] {
  let result = [...argv]
  if (result[0] === 'sandbox-exec') {
    const separator = result.indexOf('--')
    if (separator < 0 || separator === result.length - 1) throw new Error('invalid sandbox-exec wrapper')
    result = result.slice(separator + 1)
  }
  if (result[0] !== undefined) result[0] = remoteExecutable(result[0])
  return result
}


export class BlaxelSubprocessRuntime extends SubprocessRuntime {
  static inject = ['blaxel']
  private disposing = false
  private readonly live = new Set<SubprocessHandle>()

  constructor(ctx: Context) {
    super(ctx)
    ctx.effect(() => async () => {
      this.disposing = true
      const handles = [...this.live]
      for (const handle of handles) handle.terminate()
      await Promise.all(handles.map(handle => handle.waitForExit().catch(() => false)))
    }, 'blaxel subprocess teardown')
  }

  /** Processes this runtime spawned and still tracks; terminals are not tracked. */
  ownedProcesses(): number {
    return this.live.size
  }

  async resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    if (!command) throw new Error('dsh-subprocess-blaxel: executable name must be non-empty')
    signal?.throwIfAborted()
    const executable = remoteExecutable(command)
    const resolvedEnv = environmentFor(await this.ctx.blaxel.getSandboxEnvironment(), env)
    const path = resolvedEnv.PATH === undefined ? '' : `PATH=${shellQuote(resolvedEnv.PATH)} `
    const result = await this.ctx.blaxel.getSandbox().then(s => s.process.exec({ command: `${path}command -v -- ${shellQuote(executable)}`, workingDir: this.ctx.blaxel.cwd, waitForCompletion: true }))
    signal?.throwIfAborted()
    if (result.exitCode !== 0) throw new Error(`executable not found: ${executable}`)
    return result.stdout?.trim() ?? executable
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    if (this.disposing) throw new Error('dsh-subprocess-blaxel: service is disposing')
    if (spec.argv.length === 0 || !spec.argv[0]) throw new Error('invalid argv: expected a non-empty program')
    if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0 || spec.graceMs > MAX_TIMER_DELAY_MS) throw new Error('invalid graceMs')
    const handle = new BlaxelProcessHandle(this.ctx.blaxel, {
      ...spec,
      argv: remoteArgv(spec.argv),
      cwd: this.ctx.blaxel.toRemotePath(spec.cwd),
    })
    this.live.add(handle)
    void handle.done.finally(() => this.live.delete(handle))
    if (spec.signal !== undefined) spec.signal.addEventListener('abort', () => handle.terminate(), { once: true })
    return handle
  }

  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    if (this.disposing) throw new Error('dsh-subprocess-blaxel: service is disposing')
    if (spec.argv.length === 0 || !spec.argv[0]) throw new Error('terminal argv must contain a program')
    if (spec.signal?.aborted) throw new Error('terminal allocation aborted')
    const terminal = new BlaxelTerminal(this.ctx.blaxel, { ...spec, cwd: this.ctx.blaxel.toRemotePath(spec.cwd) })
    await terminal.ready
    return terminal
  }
}

export default BlaxelSubprocessRuntime
