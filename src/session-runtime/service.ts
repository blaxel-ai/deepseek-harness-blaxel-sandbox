import { Context, Service } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { SandboxInstance } from '@blaxel/core'
import '../shared/integration-user-agent.js'
import { BlaxelCapabilitiesManager, type BlaxelCapabilitiesStatus } from '../blaxel-capabilities.js'
import { BlaxelSettingsManager, type BlaxelSettingsStatus, type BrowserLoginState, type SandboxDefaults } from '../blaxel-settings.js'
import { BlaxelFileSystem } from '../filesystem/service.js'
import { BlaxelRuntime } from '../runtime/service.js'
import { BlaxelSubprocessRuntime } from '../subprocess/service.js'
import { LaunchTracker, type LaunchProgress } from '../web/launch-progress.js'
import { divergenceReader, type DivergenceResult, type DivergenceSummary } from '../web/divergence.js'
import { applySandboxPatch } from '../web/local-sync.js'
import { SandboxBindingStore, type PersistedSandboxBinding } from './binding-store.js'
import {
  createGitWorkspaceSnapshot,
  inspectGitWorkspace,
  removeGitWorkspaceSnapshot,
  type GitWorkspaceSnapshot,
  type SnapshotMeta,
} from '../web/workspace-snapshot.js'

export interface SandboxSession {
  sessionId: string
  title?: string
  workspace: string
  environment: 'production' | 'development'
  runtime: BlaxelRuntime
  fs: FileSystem
  subprocess: BlaxelSubprocessRuntime
  provenance: SnapshotMeta
  release(): Promise<void>
}

export interface SandboxSessionStatus {
  sessionId: string
  title?: string
  workspace: string
  environment: 'production' | 'development'
  state: ReturnType<BlaxelRuntime['baselineState']>['ready'] extends boolean ? BlaxelRuntime['phase'] : never
  sandbox: {
    name: string
    cwd: string
    workspaceRoot: string
    sourceCwd: string
    startedAt: string
    uptimeMs: number
    status?: string
    image?: string
    memory?: number
    region?: string
    ttl?: string
    createdAt?: string
    lastUsedAt?: string
    expiresIn?: number
  }
  provenance: SnapshotMeta
  live: { processes: number }
  error?: string
}

interface PreparedSandbox {
  snapshot: GitWorkspaceSnapshot
  runtime: BlaxelRuntime
  fs: FileSystem
  subprocess: BlaxelSubprocessRuntime
  fibers: Fiber[]
  disposed: boolean
  workspace: string
  environment: 'production' | 'development'
}

declare module '@deepseek-ai/cordis' {
  interface Context { blaxelSessions: BlaxelSessionRuntime }
}

/** Owns sandbox backends and binds each one to one ordinary DSH session id. */
export class BlaxelSessionRuntime extends Service {
  private readonly sessions = new Map<string, SandboxSession>()
  private readonly recoveryErrors = new Map<string, string>()
  private readonly bindings = new SandboxBindingStore()
  private readonly launch = new LaunchTracker()
  private readonly settings = new BlaxelSettingsManager()
  private readonly capabilities: BlaxelCapabilitiesManager
  private readonly recovery: Promise<void>
  private opening = false

  constructor(ctx: Context) {
    super(ctx, 'blaxelSessions')
    this.capabilities = new BlaxelCapabilitiesManager(ctx)
    void this.capabilities.restore()
    this.recovery = this.recoverPersistedBindings()
    ctx.effect(() => async () => {
      const sessions = [...this.sessions.values()]
      this.sessions.clear()
      await Promise.all(sessions.map(session => session.release().catch(() => undefined)))
      await this.capabilities.dispose()
    }, 'Blaxel session provider release')
  }

  get(sessionId: string | undefined): SandboxSession | undefined {
    return sessionId === undefined ? undefined : this.sessions.get(sessionId)
  }

  isSandboxSession(sessionId: string | undefined): boolean {
    return sessionId !== undefined && this.bindings.get(sessionId) !== undefined
  }

  list(): SandboxSession[] {
    return [...this.sessions.values()]
  }

  progress(): LaunchProgress | undefined {
    return this.launch.snapshot()
  }

  async settingsStatus(): Promise<BlaxelSettingsStatus & { capabilities: BlaxelCapabilitiesStatus }> {
    return { ...await this.settings.status(), capabilities: await this.capabilities.status() }
  }

  async saveDefaults(value: unknown): Promise<SandboxDefaults> {
    return await this.settings.saveDefaults(value)
  }

  async switchWorkspace(value: unknown): Promise<BlaxelSettingsStatus> {
    this.assertNoRunningSandboxes('switch workspaces')
    const status = await this.settings.switchWorkspace(value)
    await this.recoverPersistedBindings()
    return status
  }

  async login(workspace: unknown, apiKey: unknown): Promise<BlaxelSettingsStatus> {
    this.assertCompatibleWorkspace(workspace)
    const status = await this.settings.login(workspace, apiKey)
    await this.recoverPersistedBindings()
    return status
  }

  async beginBrowserLogin(): Promise<BrowserLoginState> {
    return await this.settings.beginBrowserLogin()
  }

  async pollBrowserLogin(flowId: unknown): Promise<BrowserLoginState> {
    return await this.settings.pollBrowserLogin(flowId)
  }

  async completeBrowserLogin(flowId: unknown, workspace: unknown): Promise<BlaxelSettingsStatus> {
    this.assertCompatibleWorkspace(workspace)
    const status = await this.settings.completeBrowserLogin(flowId, workspace)
    await this.recoverPersistedBindings()
    return status
  }

  async installSkills(): Promise<BlaxelCapabilitiesStatus> {
    return await this.capabilities.installSkills()
  }

  async connectMcp(): Promise<BlaxelCapabilitiesStatus> {
    return await this.capabilities.connectMcp()
  }

  async disconnectMcp(): Promise<BlaxelCapabilitiesStatus> {
    return await this.capabilities.disconnectMcp()
  }

  async logout(workspace: unknown): Promise<BlaxelSettingsStatus> {
    this.assertNoRunningSandboxes('sign out')
    return await this.settings.logout(workspace)
  }

  async testConnection(): Promise<{ workspace: string }> {
    return await this.settings.testConnection()
  }

  async prepare(inputCwd: string, kind: 'open' | 'move'): Promise<PreparedSandbox> {
    await this.recovery
    if (this.opening) throw new Error('Another sandbox session is already starting')
    this.opening = true
    this.launch.begin(kind)
    let snapshot: GitWorkspaceSnapshot | undefined
    const fibers: Fiber[] = []
    try {
      await this.settings.refreshAuthentication()
      const defaults = await this.settings.defaults()
      const connection = (await this.settings.status()).connection
      if (!connection.authenticated || connection.workspace === undefined) throw new Error('Connect a Blaxel workspace first')
      snapshot = await createGitWorkspaceSnapshot(await inspectGitWorkspace(inputCwd), this.launch.report)
      this.launch.step(kind === 'move' ? 'session' : 'starting')
      const remote = this.ctx.isolate('blaxel').isolate('fs').isolate('subprocess')
      fibers.push(await remote.plugin(BlaxelRuntime, {
        cwd: snapshot.remoteCwd,
        workspaceRoot: '/workspace',
        sourceRoot: snapshot.repoRoot,
        archivePath: snapshot.archivePath,
        image: defaults.image,
        memory: defaults.memory,
        ...(defaults.region === undefined ? {} : { region: defaults.region }),
        ...(defaults.ttl === undefined ? {} : { ttl: defaults.ttl }),
      }))
      fibers.push(await remote.plugin(BlaxelFileSystem))
      fibers.push(await remote.plugin(BlaxelSubprocessRuntime))
      const runtime = remote.get('blaxel') as BlaxelRuntime
      const filesystem = remote.get('fs') as FileSystem
      const subprocess = remote.get('subprocess') as BlaxelSubprocessRuntime
      await runtime.getSandbox()
      this.launch.step('ready')
      return {
        snapshot,
        runtime,
        fs: filesystem,
        subprocess,
        fibers,
        disposed: false,
        workspace: connection.workspace,
        environment: connection.environment,
      }
    } catch (error) {
      this.launch.fail(error instanceof Error ? error.message : String(error))
      await Promise.all(fibers.reverse().map(fiber => fiber.dispose().catch(() => undefined)))
      if (snapshot !== undefined) await removeGitWorkspaceSnapshot(snapshot)
      throw error
    } finally {
      this.opening = false
    }
  }

  async bind(prepared: PreparedSandbox, sessionId: string, title?: string): Promise<SandboxSession> {
    if (this.bindings.get(sessionId) !== undefined) throw new Error('This session already has a sandbox runtime')
    const provenance: SnapshotMeta = {
      repoRoot: prepared.snapshot.repoRoot,
      cwd: prepared.snapshot.cwd,
      remoteCwd: prepared.snapshot.remoteCwd,
      fileCount: prepared.snapshot.fileCount,
      skippedSensitive: prepared.snapshot.skippedSensitive,
      archiveBytes: prepared.snapshot.archiveBytes,
      ...(prepared.snapshot.branch === undefined ? {} : { branch: prepared.snapshot.branch }),
      ...(prepared.snapshot.commit === undefined ? {} : { commit: prepared.snapshot.commit }),
    }
    const release = async (): Promise<void> => {
      if (prepared.disposed) return
      prepared.disposed = true
      await Promise.all(prepared.fibers.reverse().map(fiber => fiber.dispose().catch(() => undefined)))
      await removeGitWorkspaceSnapshot(prepared.snapshot)
    }
    const session: SandboxSession = {
      sessionId,
      ...(title === undefined ? {} : { title }),
      workspace: prepared.workspace,
      environment: prepared.environment,
      runtime: prepared.runtime,
      fs: prepared.fs,
      subprocess: prepared.subprocess,
      provenance,
      release,
    }
    const binding: PersistedSandboxBinding = {
      sessionId,
      ...(title === undefined ? {} : { title }),
      sandboxName: prepared.runtime.name,
      cwd: prepared.runtime.cwd,
      workspaceRoot: prepared.runtime.workspaceRoot,
      sourceRoot: provenance.repoRoot,
      startedAt: prepared.runtime.startedAt,
      workspace: prepared.workspace,
      environment: prepared.environment,
      provenance,
    }
    try {
      this.bindings.save(binding)
      prepared.runtime.preserveOnDispose()
      this.recoveryErrors.delete(sessionId)
      this.sessions.set(sessionId, session)
    } catch (error) {
      await prepared.runtime.deleteSandbox().catch(() => undefined)
      await release()
      throw error
    }
    return session
  }

  async discard(prepared: PreparedSandbox): Promise<void> {
    if (prepared.disposed) return
    await prepared.runtime.deleteSandbox().catch(() => undefined)
    prepared.disposed = true
    await Promise.all(prepared.fibers.reverse().map(fiber => fiber.dispose().catch(() => undefined)))
    await removeGitWorkspaceSnapshot(prepared.snapshot)
  }

  async close(sessionId: string): Promise<void> {
    await this.recovery
    const session = this.sessions.get(sessionId)
    if (session !== undefined) {
      await this.settings.refreshAuthentication(session.workspace)
      await session.runtime.deleteSandbox()
      this.bindings.remove(sessionId)
      this.sessions.delete(sessionId)
      this.recoveryErrors.delete(sessionId)
      await session.release()
      return
    }
    const binding = this.bindings.get(sessionId)
    if (binding === undefined) return
    const connection = (await this.settings.status()).connection
    if (!connection.authenticated || connection.workspace !== binding.workspace || connection.environment !== binding.environment) {
      throw new Error(`Reconnect the ${binding.workspace} Blaxel workspace before stopping this sandbox`)
    }
    await this.settings.refreshAuthentication(binding.workspace)
    try {
      await SandboxInstance.delete(binding.sandboxName)
    } catch (error) {
      if (!/not found|404/i.test(String(error))) throw error
    }
    this.bindings.remove(sessionId)
    this.recoveryErrors.delete(sessionId)
  }

  async divergence(sessionId: string): Promise<DivergenceResult> {
    await this.recovery
    const session = this.sessions.get(sessionId)
    if (session === undefined) throw new Error('Reconnect this sandbox session before checking its changes')
    return await divergenceReader(session.runtime).read()
  }

  /** Applies remote edits locally, then removes the remote binding and sandbox. */
  async moveChangesLocal(sessionId: string): Promise<{ repoRoot: string; divergence: DivergenceSummary }> {
    await this.recovery
    const session = this.sessions.get(sessionId)
    if (session === undefined) throw new Error('Reconnect this sandbox session before moving its changes locally')
    if (session.subprocess.ownedProcesses() > 0) throw new Error('Wait for sandbox tool processes to finish before moving changes locally')
    const reader = divergenceReader(session.runtime)
    const result = await reader.read()
    if (!result.available) throw new Error(result.reason)
    const patch = await reader.patch()
    await applySandboxPatch(session.provenance.repoRoot, patch)
    try {
      await this.close(sessionId)
    } catch (error) {
      throw new Error(`Sandbox changes were applied locally, but the sandbox could not be stopped: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { repoRoot: session.provenance.repoRoot, divergence: result.divergence }
  }

  async status(): Promise<{ sandboxes: SandboxSessionStatus[]; progress?: LaunchProgress }> {
    await this.recovery
    const live = await Promise.all(this.list().map(async session => {
      const runtime = session.runtime
      const facts = runtime.phase === 'ready' ? await runtime.sandboxFacts() : { name: runtime.name }
      return {
        sessionId: session.sessionId,
        ...(session.title === undefined ? {} : { title: session.title }),
        workspace: session.workspace,
        environment: session.environment,
        state: runtime.phase,
        sandbox: {
          ...facts,
          cwd: runtime.cwd,
          workspaceRoot: runtime.workspaceRoot,
          sourceCwd: session.provenance.cwd,
          startedAt: new Date(runtime.startedAt).toISOString(),
          uptimeMs: Date.now() - runtime.startedAt,
        },
        provenance: session.provenance,
        live: { processes: session.subprocess.ownedProcesses() },
      }
    }))
    const liveIds = new Set(live.map(item => item.sessionId))
    const unavailable: SandboxSessionStatus[] = this.bindings.list().filter(binding => !liveIds.has(binding.sessionId)).map(binding => ({
      sessionId: binding.sessionId,
      ...(binding.title === undefined ? {} : { title: binding.title }),
      workspace: binding.workspace,
      environment: binding.environment,
      state: 'failed',
      sandbox: {
        name: binding.sandboxName,
        cwd: binding.cwd,
        workspaceRoot: binding.workspaceRoot,
        sourceCwd: binding.provenance.cwd,
        startedAt: new Date(binding.startedAt).toISOString(),
        uptimeMs: Date.now() - binding.startedAt,
      },
      provenance: binding.provenance,
      live: { processes: 0 },
      error: this.recoveryErrors.get(binding.sessionId) ?? 'Sandbox reconnection is pending',
    }))
    const sandboxes = [...live, ...unavailable]
    const progress = this.progress()
    return { sandboxes, ...(progress === undefined ? {} : { progress }) }
  }

  private assertNoRunningSandboxes(action: string): void {
    if (this.bindings.list().length > 0) throw new Error(`Stop running sandbox sessions before you ${action}`)
  }

  /** Running bindings may refresh only their existing workspace credentials. */
  private assertCompatibleWorkspace(workspace: unknown): void {
    const bindings = this.bindings.list()
    if (bindings.length === 0) return
    if (typeof workspace !== 'string' || workspace.trim() === '') throw new Error('Choose the workspace already used by these sandbox sessions')
    const required = new Set(bindings.map(binding => binding.workspace))
    if (required.size !== 1 || !required.has(workspace.trim())) {
      throw new Error(`Reconnect the ${[...required].join(', ')} workspace before changing sandbox authentication`)
    }
  }

  private async recoverPersistedBindings(): Promise<void> {
    for (const binding of this.bindings.list()) {
      if (this.sessions.has(binding.sessionId)) continue
      const fibers: Fiber[] = []
      try {
        const connection = (await this.settings.status()).connection
        if (!connection.authenticated) throw new Error(`Reconnect the ${binding.workspace} Blaxel workspace to restore this sandbox session`)
        if (connection.workspace !== binding.workspace || connection.environment !== binding.environment) {
          throw new Error(`Switch to the ${binding.workspace} Blaxel workspace to restore this sandbox session`)
        }
        await this.settings.refreshAuthentication(binding.workspace)
        const remote = this.ctx.isolate('blaxel').isolate('fs').isolate('subprocess')
        fibers.push(await remote.plugin(BlaxelRuntime, {
          name: binding.sandboxName,
          cwd: binding.cwd,
          workspaceRoot: binding.workspaceRoot,
          sourceRoot: binding.sourceRoot,
          resume: true,
          deleteOnDispose: false,
          startedAt: binding.startedAt,
        }))
        fibers.push(await remote.plugin(BlaxelFileSystem))
        fibers.push(await remote.plugin(BlaxelSubprocessRuntime))
        const runtime = remote.get('blaxel') as BlaxelRuntime
        await runtime.getSandbox()
        let released = false
        const session: SandboxSession = {
          sessionId: binding.sessionId,
          ...(binding.title === undefined ? {} : { title: binding.title }),
          workspace: binding.workspace,
          environment: binding.environment,
          runtime,
          fs: remote.get('fs') as FileSystem,
          subprocess: remote.get('subprocess') as BlaxelSubprocessRuntime,
          provenance: binding.provenance,
          release: async () => {
            if (released) return
            released = true
            await Promise.all(fibers.reverse().map(fiber => fiber.dispose().catch(() => undefined)))
          },
        }
        this.sessions.set(binding.sessionId, session)
        this.recoveryErrors.delete(binding.sessionId)
      } catch (error) {
        await Promise.all(fibers.reverse().map(fiber => fiber.dispose().catch(() => undefined)))
        this.recoveryErrors.set(binding.sessionId, error instanceof Error ? error.message : String(error))
      }
    }
  }
}

export default BlaxelSessionRuntime
