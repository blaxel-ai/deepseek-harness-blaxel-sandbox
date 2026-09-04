import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import type {
  SubprocessCollect,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { BlaxelRuntime } from '../runtime/service.js'
import { shellQuote } from '../shared/shell.js'
import { CollectedReader } from './collected-reader.js'
import { argvCommand, environmentFor } from './environment.js'

function isCollect(mode: SubprocessOutputMode): mode is SubprocessCollect { return typeof mode === 'object' }

export class BlaxelProcessHandle implements SubprocessHandle {
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
    // Consumers that await `ready` still see the failure; nobody else must, or
    // one lost sandbox becomes an unhandled rejection that takes DSH down.
    void this.ready.catch(() => {})
    this.id = `dsh-${randomUUID()}`
    this.done = this.start().catch((error: unknown) => {
      // A vanished sandbox reads as one sentence, not the platform's retry manifesto.
      const failure = this.runtime.markUnavailable(error) ? new Error(this.runtime.unavailableReason ?? String(error)) : error
      this.readyState.reject(failure)
      throw failure
    })
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
    }, () => undefined)
  }

  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (signal === undefined) { await this.done; return true }
    if (signal.aborted) return false
    return await Promise.race([this.done.then(() => true), new Promise<boolean>(resolve => signal.addEventListener('abort', () => resolve(false), { once: true }))])
  }

  private async start(): Promise<SubprocessOutcome> {
    const sandbox = await this.runtime.getSandbox()
    const env = environmentFor(await this.runtime.getSandboxEnvironment(), this.spec.env)
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
    if (typeof this.spec.stdio.stdin === 'object') void this.writeStdin(this.spec.stdio.stdin.data).then(() => this.closeStdin()).catch(() => undefined)
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
