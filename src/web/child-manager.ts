import { spawn, type ChildProcess } from 'node:child_process'
import { isAbsolute, join } from 'node:path'
import {
  createGitWorkspaceSnapshot,
  inspectGitWorkspace,
  removeGitWorkspaceSnapshot,
  type GitWorkspaceSnapshot,
} from './workspace-snapshot.js'

const STARTUP_TIMEOUT_MS = 90_000
const STOP_TIMEOUT_MS = 10_000
const MAX_CAPTURE_BYTES = 32 * 1024
const URL_PATTERN = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/

interface ChildState {
  process: ChildProcess
  snapshot: GitWorkspaceSnapshot
  output: string
  url?: string
}

export interface ChildStatus {
  running: boolean
  url?: string
  workspace?: { cwd: string; repoRoot: string; remoteCwd: string }
}

export interface OpenResult {
  url: string
  workspace: {
    cwd: string
    repoRoot: string
    remoteCwd: string
    fileCount: number
    skippedSensitive: number
  }
}

function appendCapped(current: string, chunk: Buffer): string {
  const next = current + chunk.toString('utf8')
  return next.length > MAX_CAPTURE_BYTES ? next.slice(-MAX_CAPTURE_BYTES) : next
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class BlaxelChildManager {
  private child: ChildState | undefined
  private opening: { cwd: string; promise: Promise<OpenResult> } | undefined
  private closing = false

  status(): ChildStatus {
    const child = this.child
    if (child === undefined) return { running: false }
    return {
      running: child.process.exitCode === null,
      ...(child.url === undefined ? {} : { url: child.url }),
      workspace: {
        cwd: child.snapshot.cwd,
        repoRoot: child.snapshot.repoRoot,
        remoteCwd: child.snapshot.remoteCwd,
      },
    }
  }

  async open(inputCwd: string): Promise<OpenResult> {
    if (this.closing) throw new Error('The current Blaxel window is stopping')
    const workspace = await inspectGitWorkspace(inputCwd)
    const child = this.child
    if (child?.process.exitCode === null) {
      if (child.snapshot.cwd !== workspace.cwd) {
        throw new Error('Another Git worktree is already open in Blaxel. Stop it from Settings before opening this one.')
      }
      if (child.url !== undefined) return this.result(child)
    }
    if (this.opening !== undefined) {
      if (this.opening.cwd !== workspace.cwd) throw new Error('Another Git worktree is currently opening in Blaxel')
      return await this.opening.promise
    }

    const promise = createGitWorkspaceSnapshot(workspace).then(async snapshot => await this.start(snapshot))
    this.opening = { cwd: workspace.cwd, promise }
    try {
      return await promise
    } finally {
      if (this.opening?.promise === promise) this.opening = undefined
    }
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    try {
      await this.opening?.promise.catch(() => undefined)
      const child = this.child
      this.child = undefined
      if (child === undefined) return
      if (child.process.exitCode === null) {
        child.process.kill('SIGTERM')
        await Promise.race([
          new Promise<void>(resolve => child.process.once('exit', () => resolve())),
          delay(STOP_TIMEOUT_MS),
        ])
        if (child.process.exitCode === null) child.process.kill('SIGKILL')
      }
      await removeGitWorkspaceSnapshot(child.snapshot)
    } finally {
      this.closing = false
    }
  }

  private result(child: ChildState): OpenResult {
    if (child.url === undefined) throw new Error('Blaxel DSH is still starting')
    return {
      url: child.url,
      workspace: {
        cwd: child.snapshot.cwd,
        repoRoot: child.snapshot.repoRoot,
        remoteCwd: child.snapshot.remoteCwd,
        fileCount: child.snapshot.fileCount,
        skippedSensitive: child.snapshot.skippedSensitive,
      },
    }
  }

  private async start(snapshot: GitWorkspaceSnapshot): Promise<OpenResult> {
    const launcher = process.argv[1]
    if (launcher === undefined || !isAbsolute(launcher)) {
      await removeGitWorkspaceSnapshot(snapshot)
      throw new Error('Cannot resolve the current dsh launcher')
    }

    const childProcess = spawn(process.execPath, [launcher, '--profile', 'web', '--port', '0'], {
      cwd: snapshot.repoRoot,
      env: {
        ...process.env,
        DSH_BLAXEL_ACTIVE: '1',
        DSH_BLAXEL_CWD: snapshot.remoteCwd,
        DSH_BLAXEL_WORKSPACE_ROOT: '/workspace',
        DSH_BLAXEL_SNAPSHOT: snapshot.archivePath,
        DSH_BLAXEL_SESSION_ROOT: join(snapshot.tempDir, 'sessions'),
        DSH_BLAXEL_STORAGE_ROOT: join(snapshot.tempDir, 'storages'),
        DSH_BLAXEL_SOURCE_CWD: snapshot.cwd,
        DSH_BLAXEL_SOURCE_ROOT: snapshot.repoRoot,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const state: ChildState = { process: childProcess, snapshot, output: '' }
    this.child = state

    const observe = (chunk: Buffer): void => {
      state.output = appendCapped(state.output, chunk)
      const match = URL_PATTERN.exec(state.output)
      if (match?.[1] !== undefined) state.url = match[1]
    }
    childProcess.stdout?.on('data', observe)
    childProcess.stderr?.on('data', observe)
    childProcess.once('exit', () => {
      if (this.child?.process === childProcess) this.child = undefined
      void removeGitWorkspaceSnapshot(snapshot)
    })

    return await this.waitUntilReady(state)
  }

  private async waitUntilReady(state: ChildState): Promise<OpenResult> {
    return await new Promise<OpenResult>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        if (state.url !== undefined) {
          settled = true
          clearInterval(interval)
          clearTimeout(timeout)
          resolve(this.result(state))
        } else if (error !== undefined) {
          settled = true
          clearInterval(interval)
          clearTimeout(timeout)
          reject(error)
        }
      }
      const interval = setInterval(() => finish(), 25)
      const timeout = setTimeout(() => {
        state.process.kill('SIGTERM')
        finish(new Error('Blaxel DSH did not become ready within 90 seconds'))
      }, STARTUP_TIMEOUT_MS)
      state.process.once('error', error => finish(new Error('Could not start the Blaxel DSH process', { cause: error })))
      state.process.once('exit', code => finish(new Error(`Blaxel DSH exited before becoming ready${code === null ? '' : ` (code ${String(code)})`}`)))
    })
  }
}
