import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { PassThrough } from 'node:stream'
import { settings } from '@blaxel/core'
import '../shared/integration-user-agent.js'
import type {
  SubprocessOutcome,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import WebSocket from 'ws'
import type { BlaxelRuntime } from '../runtime/service.js'
import { shellQuote } from '../shared/shell.js'
import { argvArgs, envArgs, environmentFor } from './environment.js'

export class BlaxelTerminal implements SubprocessTerminalHandle {
  readonly output = new PassThrough()
  readonly done: Promise<SubprocessOutcome>
  private socket!: WebSocket
  private closed = false
  private readonly stateFile: string
  private processId = -1
  readonly ready: Promise<void>
  private readonly readyState = Promise.withResolvers<void>()

  constructor(private readonly runtime: BlaxelRuntime, private readonly spec: SubprocessTerminalSpawnSpec) {
    this.stateFile = posix.join(runtime.runtimeRoot, 'terminals', `${randomUUID()}.pid`)
    this.ready = this.readyState.promise
    this.done = this.open().catch(error => { this.readyState.reject(error); throw error })
    void this.done.catch(() => {})
  }

  get pid(): number { return this.processId }

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
    const env = environmentFor(await this.runtime.getSandboxEnvironment(), this.spec.env)
    const command = `printf '%s' "$$" > ${shellQuote(this.stateFile)}; exec env -i ${envArgs(env)} ${argvArgs(this.spec.argv)}\r`
    socket.on('message', data => {
      try {
        const frame = JSON.parse(String(data)) as { type?: string; data?: string }
        if (frame.type === 'output' && frame.data !== undefined) this.output.write(Buffer.from(frame.data))
        if (frame.type === 'error') this.output.destroy(new Error(frame.data ?? 'terminal error'))
      } catch { /* protocol errors are surfaced by close/output */ }
    })
    socket.on('close', () => { this.output.end() })
    socket.send(JSON.stringify({ type: 'input', data: command }))
    this.processId = await this.readPid(5_000) ?? -1
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
