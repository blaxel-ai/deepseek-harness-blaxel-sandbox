/** Blaxel implementation of DSH subprocess and terminal capability seams. */
import { Buffer } from 'node:buffer'
import { PassThrough, Writable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import WebSocket from 'ws'
import { Context, Service } from '@deepseek-ai/cordis'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessCollect,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
  SubprocessStdio,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { settings } from '@blaxel/core'
import type { BlaxelRuntime } from 'dsh-blaxel'
import { shellQuote } from 'dsh-blaxel'

declare module '@deepseek-ai/cordis' {
  interface Context { blaxel: BlaxelRuntime }
}

const MAX_TIMER_DELAY_MS = 2_147_483_647

function envFor(spec: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const result = scrubbedParentEnv()
  for (const [key, value] of Object.entries(spec ?? {})) {
    if (value === undefined) delete result[key]
    else result[key] = String(value)
  }
  return result
}

function argvCommand(argv: readonly string[], env: Record<string, string>, cwd: string, fifo?: string): string {
  const envArgs = Object.entries(env).map(([key, value]) => `${shellQuote(`${key}=${value}`)}`).join(' ')
  const args = argv.map(shellQuote).join(' ')
  const input = fifo === undefined ? ' </dev/null' : ` < ${shellQuote(fifo)}`
  return `cd -- ${shellQuote(cwd)} && exec setsid env -i ${envArgs} ${args}${input}`
}

function isCollect(mode: SubprocessOutputMode): mode is SubprocessCollect { return typeof mode === 'object' }

class CollectedReader implements SubprocessOutputReader {
  private total = 0
  private tail = Buffer.alloc(0)
  private full = Buffer.alloc(0)
  private finished = false
  private spillReady = false

  constructor(private readonly mode: SubprocessCollect, readonly spillPath?: string) {}

  push(chunk: string | Buffer): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.total += bytes.length
    this.tail = Buffer.concat([this.tail, bytes]).subarray(-this.mode.maxBytes)
    if (this.mode.spill !== undefined && this.full.length <= this.mode.spill.maxBytes) {
      this.full = Buffer.concat([this.full, bytes])
      if (this.full.length > this.mode.spill.maxBytes) this.full = Buffer.alloc(0)
    }
  }

  finish(): void { this.finished = true }

  async persist(sandbox: Awaited<ReturnType<BlaxelRuntime['getSandbox']>>): Promise<void> {
    if (this.spillPath === undefined || this.full.length === 0 || this.full.length !== this.total) return
    await sandbox.fs.writeBinary(this.spillPath, this.full)
    this.spillReady = true
  }

  readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string } {
    const start = Math.max(0, Number.isFinite(fromByte) ? fromByte : 0)
    const tailStart = this.total - this.tail.length
    const lossy = start < tailStart
    const offset = lossy ? tailStart : start
    const local = this.tail.subarray(Math.max(0, offset - tailStart))
    return {
      text: local.toString('utf8'),
      nextOffset: this.total,
      lossy,
      ...(lossy && this.spillPath !== undefined && this.finished && this.spillReady ? { spillPath: this.spillPath } : {}),
    }
  }
}

class BlaxelHandle implements SubprocessHandle {
  readonly stdin: Writable | undefined
  readonly stdout: PassThrough | undefined
  readonly stderr: PassThrough | undefined
  readonly collected: SubprocessHandle['collected']
  readonly done: Promise<SubprocessOutcome>
  private readonly stdoutReader: CollectedReader | undefined
  private readonly stderrReader: CollectedReader | undefined
  private id: string
  private fifo: string | undefined
  private terminated = false
  private stream: { close: () => void; wait: () => Promise<void> } | undefined
  private readonly ready: Promise<void>
  private readonly readyState = Promise.withResolvers<void>()

  constructor(private readonly runtime: BlaxelRuntime, private readonly spec: SubprocessSpawnSpec) {
    const outMode = spec.stdio.stdout
    const errMode = spec.stdio.stderr
    this.stdout = outMode === 'pipe' ? new PassThrough() : undefined
    this.stderr = errMode === 'pipe' ? new PassThrough() : undefined
    this.stdoutReader = isCollect(outMode) ? new CollectedReader(outMode, outMode.spill === undefined ? undefined : posix.join(runtime.runtimeRoot, 'spills', `${randomUUID()}.stdout`)) : undefined
    this.stderrReader = isCollect(errMode) ? new CollectedReader(errMode, errMode.spill === undefined ? undefined : posix.join(runtime.runtimeRoot, 'spills', `${randomUUID()}.stderr`)) : undefined
    this.collected = {
      ...(this.stdoutReader !== undefined ? { stdout: this.stdoutReader } : {}),
      ...(this.stderrReader !== undefined ? { stderr: this.stderrReader } : {}),
    }
    this.stdin = spec.stdio.stdin === 'pipe' ? new Writable({
      write: (chunk, _encoding, callback) => { void this.writeStdin(String(chunk)).then(() => callback(), callback) },
      final: callback => { void this.closeStdin().then(() => callback(), callback) },
    }) : undefined
    this.ready = this.readyState.promise
    this.id = `dsh-${randomUUID()}`
    this.done = this.start().catch(error => { this.readyState.reject(error); throw error })
    void this.done.catch(() => {})
  }

  get pid(): number { return Number.parseInt(this.id.replace(/^dsh-/, '').slice(0, 8), 16) || -1 }

  terminate(): void {
    if (this.terminated) return
    this.terminated = true
    void this.ready.then(async () => {
      const sandbox = await this.runtime.getSandbox().catch(() => undefined)
      if (sandbox === undefined) return
      await sandbox.process.kill(this.id).catch(() => undefined)
      this.stream?.close()
      this.stdout?.destroy()
      this.stderr?.destroy()
    })
  }

  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (signal === undefined) { await this.done; return true }
    if (signal.aborted) return false
    return await Promise.race([this.done.then(() => true), new Promise<boolean>(resolve => signal.addEventListener('abort', () => resolve(false), { once: true }))])
  }

  private async start(): Promise<SubprocessOutcome> {
    const sandbox = await this.runtime.getSandbox()
    const env = envFor(this.spec.env)
    const fifo = this.spec.stdio.stdin !== 'ignore' ? posix.join(this.runtime.runtimeRoot, 'stdin', randomUUID()) : undefined
    this.fifo = fifo
    if (fifo !== undefined) await sandbox.process.exec({ name: `${this.id}-fifo`, command: `mkdir -p ${shellQuote(posix.dirname(fifo))} && rm -f ${shellQuote(fifo)} && mkfifo ${shellQuote(fifo)}`, workingDir: this.spec.cwd, waitForCompletion: true })
    const response = await sandbox.process.exec({
      name: this.id,
      command: argvCommand(this.spec.argv, env, this.spec.cwd, fifo),
      workingDir: this.spec.cwd,
      waitForCompletion: false,
      timeout: 0,
    })
    const id = String(response.pid ?? this.id)
    this.id = id
    this.readyState.resolve()
    this.stream = sandbox.process.streamLogs(id, {
      onStdout: chunk => this.onOutput('stdout', chunk),
      onStderr: chunk => this.onOutput('stderr', chunk),
      onError: error => { this.stdout?.destroy(error); this.stderr?.destroy(error) },
    })
    if (typeof this.spec.stdio.stdin === 'object') void this.writeStdin(this.spec.stdio.stdin.data).then(() => this.closeStdin(), () => undefined)
    try {
      await this.stream.wait()
      const result = await sandbox.process.wait(id, { maxWait: Math.max(1, this.spec.graceMs), interval: 50 }).catch(() => sandbox.process.get(id))
      return { exitCode: result.exitCode ?? null, signal: this.terminated ? 'SIGTERM' : null }
    } finally {
      this.stream.close()
      this.stdout?.end(); this.stderr?.end()
      this.stdoutReader?.finish(); this.stderrReader?.finish()
      await this.stdoutReader?.persist(sandbox)
      await this.stderrReader?.persist(sandbox)
      if (fifo !== undefined) await sandbox.fs.rm(fifo).catch(() => undefined)
    }
  }

  private onOutput(kind: 'stdout' | 'stderr', data: string): void {
    const bytes = Buffer.from(data)
    const mode = this.spec.stdio[kind]
    if (kind === 'stdout') {
      this.stdout?.write(bytes)
      this.stdoutReader?.push(bytes)
      if (mode === 'inherit') process.stdout.write(bytes)
    } else {
      this.stderr?.write(bytes)
      this.stderrReader?.push(bytes)
      if (mode === 'inherit') process.stderr.write(bytes)
    }
  }

  private async writeStdin(data: string): Promise<void> {
    await this.ready
    if (this.fifo === undefined) throw new Error('dsh-subprocess-blaxel: stdin pipe is not available after allocation')
    const sandbox = await this.runtime.getSandbox()
    await sandbox.process.exec({ command: `printf '%s' ${shellQuote(data)} > ${shellQuote(this.fifo)}`, workingDir: this.spec.cwd, waitForCompletion: true })
  }

  private async closeStdin(): Promise<void> {
    if (this.fifo === undefined) return
    await (await this.runtime.getSandbox()).fs.rm(this.fifo).catch(() => undefined)
  }
}

class BlaxelTerminal implements SubprocessTerminalHandle {
  readonly output = new PassThrough()
  readonly done: Promise<SubprocessOutcome>
  readonly pid: number
  private socket!: WebSocket
  private closed = false
  private readonly stateFile: string
  readonly ready: Promise<void>
  private readonly readyState = Promise.withResolvers<void>()

  constructor(private readonly runtime: BlaxelRuntime, private readonly spec: SubprocessTerminalSpawnSpec) {
    this.stateFile = posix.join(runtime.runtimeRoot, 'terminals', `${randomUUID()}.pid`)
    this.pid = -1
    this.ready = this.readyState.promise
    this.done = this.open().catch(error => { this.readyState.reject(error); throw error })
    void this.done.catch(() => {})
  }

  async write(data: string): Promise<void> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) throw new Error('terminal is closed')
    this.socket.send(JSON.stringify({ type: 'input', data }))
  }

  async inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
    const pid = await this.readPid()
    if (pid === undefined) return undefined
    try {
      const result = await this.runtime.getSandbox().then(s => s.process.exec({ command: `ps -o tpgid= -p ${pid}`, workingDir: this.spec.cwd, waitForCompletion: true }))
      const processGroupId = Number(result.stdout?.trim())
      return Number.isSafeInteger(processGroupId) && processGroupId > 0 ? { processGroupId, inputWaiting: false } : undefined
    } catch { return undefined }
  }

  async signalForeground(signal: SubprocessTerminalSignal): Promise<number> {
    const foreground = await this.inspectForeground()
    if (foreground === undefined) throw new Error('cannot resolve terminal foreground process group')
    if (signal === 'SIGKILL' && foreground.processGroupId === this.pid) throw new Error('refusing to SIGKILL the terminal shell; terminate it instead')
    await this.runtime.getSandbox().then(s => s.process.exec({ command: `kill -${signal.slice(3)} -- -${foreground.processGroupId}`, workingDir: this.spec.cwd, waitForCompletion: true }))
    return foreground.processGroupId
  }

  async terminate(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const pid = await this.readPid()
    if (pid !== undefined) await this.runtime.getSandbox().then(s => s.process.exec({ command: `kill -TERM -- -${pid}`, workingDir: this.spec.cwd, waitForCompletion: true }).catch(() => undefined))
    this.socket.close()
    this.output.end()
    await this.done.catch(() => undefined)
  }

  private async open(): Promise<SubprocessOutcome> {
    const sandbox = await this.runtime.getSandbox()
    await sandbox.fs.mkdir(posix.dirname(this.stateFile))
    const base = String((sandbox.metadata as unknown as { url?: string }).url ?? '').replace(/\/$/, '')
    if (!base) throw new Error('dsh-subprocess-blaxel: sandbox metadata URL is unavailable for terminal WebSocket')
    const query = new URLSearchParams({ token: settings.token, cols: String(this.spec.cols), rows: String(this.spec.rows), workingDir: this.spec.cwd })
    const socket = new WebSocket(`${base}/terminal/ws?${query}`)
    this.socket = socket
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
    const env = envFor(this.spec.env)
    const command = `printf '%s' "$$" > ${shellQuote(this.stateFile)}; exec env -i ${Object.entries(env).map(([k, v]) => shellQuote(`${k}=${v}`)).join(' ')} ${this.spec.argv.map(shellQuote).join(' ')}\r`
    socket.on('message', data => {
      try {
        const frame = JSON.parse(String(data)) as { type?: string; data?: string }
        if (frame.type === 'output' && frame.data !== undefined) this.output.write(Buffer.from(frame.data))
        if (frame.type === 'error') this.output.destroy(new Error(frame.data ?? 'terminal error'))
      } catch { /* protocol errors are surfaced by close/output */ }
    })
    socket.on('close', () => { this.output.end() })
    socket.send(JSON.stringify({ type: 'input', data: command }))
    const pid = await this.readPid(5_000)
    ;(this as { pid: number }).pid = pid ?? -1
    this.readyState.resolve()
    return await new Promise<SubprocessOutcome>(resolve => socket.once('close', () => resolve({ exitCode: null, signal: null })))
  }

  private async readPid(timeoutMs = 1_000): Promise<number | undefined> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const value = await (await this.runtime.getSandbox()).fs.read(this.stateFile)
        const pid = Number(value.trim())
        if (Number.isSafeInteger(pid) && pid > 0) return pid
      } catch { /* shell has not written it yet */ }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return undefined
  }
}

export class BlaxelSubprocessRuntime extends Service {
  static inject = ['blaxel']
  private disposing = false
  private readonly live = new Set<SubprocessHandle>()

  constructor(ctx: Context) {
    super(ctx, 'subprocess')
    ctx.effect(() => async () => {
      this.disposing = true
      const handles = [...this.live]
      for (const handle of handles) handle.terminate()
      await Promise.all(handles.map(handle => handle.waitForExit().catch(() => false)))
    }, 'blaxel subprocess teardown')
  }

  async resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    if (!command) throw new Error('dsh-subprocess-blaxel: executable name must be non-empty')
    signal?.throwIfAborted()
    const path = env?.PATH === undefined ? '' : `PATH=${shellQuote(env.PATH)} `
    const result = await this.ctx.blaxel.getSandbox().then(s => s.process.exec({ command: `${path}command -v -- ${shellQuote(command)}`, workingDir: this.ctx.blaxel.cwd, waitForCompletion: true }))
    signal?.throwIfAborted()
    if (result.exitCode !== 0) throw new Error(`executable not found: ${command}`)
    return result.stdout?.trim() ?? command
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    if (this.disposing) throw new Error('dsh-subprocess-blaxel: service is disposing')
    if (spec.argv.length === 0 || !spec.argv[0]) throw new Error('invalid argv: expected a non-empty program')
    if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0 || spec.graceMs > MAX_TIMER_DELAY_MS) throw new Error('invalid graceMs')
    const handle = new BlaxelHandle(this.ctx.blaxel, spec)
    this.live.add(handle)
    void handle.done.finally(() => this.live.delete(handle))
    if (spec.signal !== undefined) spec.signal.addEventListener('abort', () => handle.terminate(), { once: true })
    return handle
  }

  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    if (this.disposing) throw new Error('dsh-subprocess-blaxel: service is disposing')
    if (spec.argv.length === 0 || !spec.argv[0]) throw new Error('terminal argv must contain a program')
    if (spec.signal?.aborted) throw new Error('terminal allocation aborted')
    const terminal = new BlaxelTerminal(this.ctx.blaxel, spec)
    await terminal.ready
    return terminal
  }
}

export default BlaxelSubprocessRuntime
