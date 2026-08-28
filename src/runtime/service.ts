/** Shared ownership of one Blaxel sandbox for DSH provider adapters. */
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SandboxInstance } from '@blaxel/core'
import type { SandboxCreateConfiguration } from '@blaxel/core'
import { BASELINE_PENDING, createBaseline, restoreBaseline, type BlaxelBaseline } from './baseline.js'
import { readSandboxEnvironment } from './environment.js'
import { mapWorkspacePath, resolveRuntimePaths, type RuntimePaths } from './paths.js'
import { prepareRuntimeTools, protectRuntimeRoot, restoreWorkspace } from './workspace.js'

export type { SandboxCreateConfiguration, SandboxInstance } from '@blaxel/core'
export type { BlaxelBaseline } from './baseline.js'

export interface Config extends Omit<SandboxCreateConfiguration, 'name'> {
  /** Explicit sandbox name; otherwise a unique disposable name is generated. */
  name?: string
  /** Remote working directory shared by all mounted DSH capabilities. */
  cwd?: string
  /** Root where the selected Git worktree is restored. */
  workspaceRoot?: string
  /** Host Git worktree root whose absolute paths map into workspaceRoot. */
  sourceRoot?: string
  /** Host archive restored into the sandbox before the session becomes ready. */
  archivePath?: string
  /** Reconnect to an existing sandbox instead of creating and restoring one. */
  resume?: boolean
  /** Delete the sandbox when this Cordis service is disposed. */
  deleteOnDispose?: boolean
  /** Original sandbox-session start time restored from durable binding state. */
  startedAt?: number
}

/** How far `open()` has got. The Blaxel window reports this instead of waiting. */
export type BlaxelPhase = 'creating' | 'restoring' | 'ready' | 'failed'

/** Point-in-time sandbox facts recorded when the instance was created or last read. */
export interface BlaxelSandboxFacts {
  name: string
  status?: string
  region?: string
  image?: string
  memory?: number
  ttl?: string
  createdAt?: string
  lastUsedAt?: string
  expiresIn?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context { blaxel: BlaxelRuntime }
}

/**
 * Creates one Blaxel sandbox and exposes it to filesystem and subprocess
 * adapters through `ctx.blaxel`. Credentials remain in the Blaxel SDK config
 * (CLI login or BL_* environment variables) and are never copied into the VM.
 */
export class BlaxelRuntime extends Service {
  static Config: z<Config> = z.object({
    name: z.string(),
    cwd: z.string().default('/workspace'),
    workspaceRoot: z.string().default('/workspace'),
    sourceRoot: z.string(),
    archivePath: z.string(),
    resume: z.boolean().default(false),
    deleteOnDispose: z.boolean().default(true),
    startedAt: z.number(),
    image: z.string().default('blaxel/ts-app:latest'),
    memory: z.number().default(4096),
    region: z.string(),
    ttl: z.string(),
    expires: z.date(),
    ports: z.any(),
    envs: z.any(),
    volumes: z.any(),
    lifecycle: z.any(),
    network: z.any(),
    snapshotEnabled: z.boolean(),
    labels: z.any(),
    extraArgs: z.any(),
    externalId: z.string(),
  })

  readonly paths: RuntimePaths
  readonly cwd: string
  readonly workspaceRoot: string
  readonly sourceRoot: string | undefined
  readonly runtimeRoot: string
  readonly name: string
  /** Host clock reading from when this service started creating the sandbox. */
  readonly startedAt: number

  private readonly config: Config
  private readonly ready: Promise<SandboxInstance>
  private environmentReady: Promise<ReadonlyMap<string, string>> | undefined
  private baseline: BlaxelBaseline | undefined
  private lifecycle: BlaxelPhase = 'creating'
  private disposed = false
  private deleteOnDispose: boolean

  constructor(ctx: Context, config: Config) {
    super(ctx, 'blaxel')
    this.config = config
    this.deleteOnDispose = config.deleteOnDispose ?? true
    this.startedAt = config.startedAt ?? Date.now()
    this.paths = resolveRuntimePaths(config)
    this.cwd = this.paths.cwd
    this.workspaceRoot = this.paths.workspaceRoot
    this.sourceRoot = this.paths.sourceRoot
    this.runtimeRoot = this.paths.runtimeRoot
    this.name = config.name ?? `dsh-${randomUUID().replaceAll('-', '').slice(0, 16)}`
    this.ready = this.open()
    void this.ready.catch(() => { this.lifecycle = 'failed' })
    ctx.effect(() => async () => this.teardown(), 'blaxel sandbox teardown')
  }

  /** Readable without awaiting the sandbox, so a starting window can say so. */
  get phase(): BlaxelPhase {
    return this.lifecycle
  }

  async getSandbox(): Promise<SandboxInstance> {
    if (this.disposed) throw new Error('dsh-blaxel: service is disposing')
    const sandbox = await this.ready
    if (this.disposed) throw new Error('dsh-blaxel: service is disposing')
    return sandbox
  }

  async getSandboxEnvironment(): Promise<ReadonlyMap<string, string>> {
    this.environmentReady ??= this.getSandbox().then(sandbox => readSandboxEnvironment(sandbox, this.cwd))
    return await this.environmentReady
  }

  toRemotePath(path: string): string {
    return mapWorkspacePath(this.sourceRoot, this.workspaceRoot, path)
  }

  /** Baseline state for divergence reports; never throws and never blocks. */
  baselineState(): BlaxelBaseline {
    return this.baseline ?? BASELINE_PENDING
  }

  /**
   * Sandbox facts from the cached configuration the instance was created with,
   * so they are a point-in-time snapshot and perform no platform request.
   */
  async sandboxFacts(): Promise<BlaxelSandboxFacts> {
    const sandbox = await this.getSandbox()
    const runtime = sandbox.spec.runtime
    return {
      name: sandbox.metadata.name,
      ...(sandbox.status === undefined ? {} : { status: sandbox.status }),
      ...(sandbox.spec.region === undefined ? { region: this.config.region } : { region: sandbox.spec.region }),
      ...(runtime?.image === undefined ? { image: this.config.image } : { image: runtime.image }),
      ...(runtime?.memory === undefined ? { memory: this.config.memory } : { memory: runtime.memory }),
      ...(runtime?.ttl === undefined ? {} : { ttl: runtime.ttl }),
      ...(sandbox.metadata.createdAt === undefined ? {} : { createdAt: sandbox.metadata.createdAt }),
      ...(sandbox.lastUsedAt === undefined ? {} : { lastUsedAt: sandbox.lastUsedAt }),
      ...(sandbox.expiresIn === undefined ? {} : { expiresIn: sandbox.expiresIn }),
    }
  }

  /** Explicit user stop. Session-host disposal can preserve a reconnectable sandbox. */
  async deleteSandbox(): Promise<void> {
    const sandbox = await this.ready
    try {
      await sandbox.delete()
      this.reportLifecycle('deleted')
    } catch (error) {
      if (!/not found|404/i.test(String(error))) throw error
    }
  }

  /** Transfers deletion ownership to the durable session binding. */
  preserveOnDispose(): void {
    this.deleteOnDispose = false
  }

  private async teardown(): Promise<void> {
    this.disposed = true
    if (!this.deleteOnDispose) return
    const sandbox = await this.ready.catch(() => undefined)
    if (sandbox === undefined) return
    try {
      await sandbox.delete()
      this.reportLifecycle('deleted')
    } catch (error) {
      if (!/not found|404/i.test(String(error))) throw error
    }
  }

  private reportLifecycle(action: 'created' | 'reconnected' | 'deleted'): void {
    this.ctx.logger.info(`Blaxel sandbox ${action}: %s`, this.name)
    process.stderr.write(`Blaxel sandbox ${action}: ${this.name}\n`)
  }

  private async open(): Promise<SandboxInstance> {
    if (this.config.resume === true) {
      const sandbox = await SandboxInstance.get(this.name)
      if (/failed|deleting|terminated/i.test(String(sandbox.status ?? ''))) throw new Error(`Blaxel sandbox ${this.name} is ${String(sandbox.status)}`)
      await protectRuntimeRoot(sandbox, this.paths)
      await prepareRuntimeTools(sandbox, this.paths)
      this.baseline = await restoreBaseline(sandbox, this.paths)
      if (!this.baseline.ready) throw new Error(this.baseline.reason)
      this.lifecycle = 'ready'
      this.reportLifecycle('reconnected')
      return sandbox
    }
    const {
      name: _name,
      cwd: _cwd,
      workspaceRoot: _workspaceRoot,
      sourceRoot: _sourceRoot,
      archivePath: _archivePath,
      resume: _resume,
      deleteOnDispose: _deleteOnDispose,
      startedAt: _startedAt,
      ...options
    } = this.config
    const sandbox = await SandboxInstance.create({ ...options, name: this.name })
    try {
      this.lifecycle = 'restoring'
      await sandbox.fs.mkdir(this.workspaceRoot)
      await sandbox.fs.mkdir(this.cwd)
      await sandbox.fs.mkdir(this.runtimeRoot)
      const archive = this.config.archivePath
      if (archive !== undefined) await restoreWorkspace(sandbox, this.paths, archive)
      await protectRuntimeRoot(sandbox, this.paths)
      await prepareRuntimeTools(sandbox, this.paths)
      // The baseline is the recovery contract. Tools must not edit the workspace
      // until its original tree has been committed successfully.
      this.baseline = await createBaseline(sandbox, this.paths)
      if (!this.baseline.ready) throw new Error(this.baseline.reason)
      this.lifecycle = 'ready'
      this.reportLifecycle('created')
      return sandbox
    } catch (error) {
      this.lifecycle = 'failed'
      await sandbox.delete().catch(() => undefined)
      throw error
    }
  }
}

export default BlaxelRuntime
