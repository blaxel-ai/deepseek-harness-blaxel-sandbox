/** Shared ownership of one Blaxel sandbox for DSH provider adapters. */
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, posix, relative, sep } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SandboxInstance } from '@blaxel/core'
import type { SandboxCreateConfiguration } from '@blaxel/core'

export type { SandboxCreateConfiguration, SandboxInstance } from '@blaxel/core'

export interface Config extends Omit<SandboxCreateConfiguration, 'name'> {
  /** Explicit sandbox name; otherwise a unique disposable name is generated. */
  name?: string
  /** Remote working directory shared by all mounted DSH capabilities. */
  cwd?: string
  /** Root where the selected Git worktree is restored. */
  workspaceRoot?: string
  /** Host Git worktree root whose absolute paths map into workspaceRoot. */
  sourceRoot?: string
}

interface ResolvedConfig extends Config {
  cwd: string
}

const BASE64_TEXT = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export function mapWorkspacePath(sourceRoot: string | undefined, workspaceRoot: string, path: string): string {
  if (sourceRoot === undefined || !isAbsolute(path)) return path
  const suffix = relative(sourceRoot, path)
  if (suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) return path
  return suffix === '' ? workspaceRoot : posix.join(workspaceRoot, ...suffix.split(sep))
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
    image: z.string().default('blaxel/node:latest'),
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

  readonly cwd: string
  readonly workspaceRoot: string
  readonly sourceRoot: string | undefined
  readonly runtimeRoot: string
  readonly name: string

  private readonly config: ResolvedConfig
  private readonly ready: Promise<SandboxInstance>
  private environmentReady: Promise<ReadonlyMap<string, string>> | undefined
  private disposed = false

  constructor(ctx: Context, config: Config) {
    super(ctx, 'blaxel')
    const resolved = config as ResolvedConfig
    this.config = { ...resolved, cwd: resolved.cwd, workspaceRoot: resolved.workspaceRoot }
    this.cwd = this.config.cwd
    this.workspaceRoot = this.config.workspaceRoot ?? '/workspace'
    this.sourceRoot = this.config.sourceRoot
    if (!posix.isAbsolute(this.cwd)) throw new Error(`dsh-blaxel: cwd must be absolute: ${this.cwd}`)
    if (!posix.isAbsolute(this.workspaceRoot)) throw new Error(`dsh-blaxel: workspaceRoot must be absolute: ${this.workspaceRoot}`)
    if (this.sourceRoot !== undefined && !isAbsolute(this.sourceRoot)) throw new Error(`dsh-blaxel: sourceRoot must be absolute: ${this.sourceRoot}`)
    const relativeCwd = posix.relative(this.workspaceRoot, this.cwd)
    if (relativeCwd === '..' || relativeCwd.startsWith('../') || posix.isAbsolute(relativeCwd)) {
      throw new Error(`dsh-blaxel: cwd must be within workspaceRoot: ${this.cwd}`)
    }
    this.runtimeRoot = posix.join(this.workspaceRoot, '.dsh-blaxel')
    this.name = this.config.name ?? `dsh-${randomUUID().replaceAll('-', '').slice(0, 16)}`
    this.ready = this.open()
    void this.ready.catch(() => {})
    ctx.effect(() => async () => {
      this.disposed = true
      const sandbox = await this.ready.catch(() => undefined)
      if (sandbox !== undefined) {
        try {
          await sandbox.delete()
          this.reportLifecycle('deleted')
        } catch (error) {
          if (!/not found|404/i.test(String(error))) throw error
        }
      }
    }, 'blaxel sandbox teardown')
  }

  async getSandbox(): Promise<SandboxInstance> {
    if (this.disposed) throw new Error('dsh-blaxel: service is disposing')
    const sandbox = await this.ready
    if (this.disposed) throw new Error('dsh-blaxel: service is disposing')
    return sandbox
  }

  async getSandboxEnvironment(): Promise<ReadonlyMap<string, string>> {
    this.environmentReady ??= this.readSandboxEnvironment()
    return this.environmentReady
  }

  toRemotePath(path: string): string {
    return mapWorkspacePath(this.sourceRoot, this.workspaceRoot, path)
  }

  private reportLifecycle(action: 'created' | 'deleted'): void {
    this.ctx.logger.info(`Blaxel sandbox ${action}: %s`, this.name)
    process.stderr.write(`Blaxel sandbox ${action}: ${this.name}\n`)
  }

  private async readSandboxEnvironment(): Promise<ReadonlyMap<string, string>> {
    const sandbox = await this.getSandbox()
    const result = await sandbox.process.exec({
      name: `dsh-blaxel-environment-${randomUUID()}`,
      command: 'set -o pipefail; env -0 | base64 -w0',
      workingDir: this.cwd,
      waitForCompletion: true,
    })
    if (result.exitCode !== 0) throw new Error(`dsh-blaxel: could not read sandbox environment: ${result.stderr || result.logs || result.exitCode}`)
    const encoded = result.stdout?.trim() ?? ''
    if (!BASE64_TEXT.test(encoded)) throw new Error('dsh-blaxel: sandbox environment transport returned invalid base64')
    let raw: string
    try {
      raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(encoded, 'base64'))
    } catch (error) {
      throw new Error('dsh-blaxel: sandbox environment is not valid UTF-8', { cause: error })
    }
    const environment = new Map<string, string>()
    for (const entry of raw.split('\0')) {
      if (entry.length === 0) continue
      const separator = entry.indexOf('=')
      if (separator <= 0) continue
      environment.set(entry.slice(0, separator), entry.slice(separator + 1))
    }
    return environment
  }

  private async open(): Promise<SandboxInstance> {
    const { name: _name, cwd: _cwd, workspaceRoot: _workspaceRoot, sourceRoot: _sourceRoot, ...options } = this.config
    const sandbox = await SandboxInstance.create({ ...options, name: this.name })
    try {
      await sandbox.fs.mkdir(this.workspaceRoot)
      await sandbox.fs.mkdir(this.cwd)
      await sandbox.fs.mkdir(this.runtimeRoot)
      const snapshotPath = process.env.DSH_BLAXEL_SNAPSHOT
      if (snapshotPath !== undefined) {
        const archivePath = posix.join(this.runtimeRoot, 'workspace.tar.gz')
        await sandbox.fs.writeBinary(archivePath, await readFile(snapshotPath))
        const extracted = await sandbox.process.exec({
          name: 'dsh-blaxel-restore-workspace',
          command: `tar -xzf ${shellQuote(archivePath)} -C ${shellQuote(this.workspaceRoot)} && rm -f -- ${shellQuote(archivePath)}`,
          workingDir: this.workspaceRoot,
          waitForCompletion: true,
        })
        if (extracted.exitCode !== 0) {
          throw new Error(`dsh-blaxel: could not restore Git worktree: ${extracted.stderr || extracted.logs || extracted.exitCode}`)
        }
      }
      await sandbox.process.exec({
        name: 'dsh-blaxel-protect-runtime',
        command: `chmod 700 -- ${shellQuote(this.runtimeRoot)}`,
        workingDir: this.cwd,
        waitForCompletion: true,
      })
      this.reportLifecycle('created')
      return sandbox
    } catch (error) {
      await sandbox.delete().catch(() => undefined)
      throw error
    }
  }
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

export default BlaxelRuntime
