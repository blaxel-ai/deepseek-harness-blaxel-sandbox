import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import type { SnapshotMeta } from '../web/workspace-snapshot.js'

const FORMAT_VERSION = 1
const SESSION_ID = /^[^/\\\0]{1,512}$/
const SANDBOX_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const WORKSPACE_NAME = SANDBOX_NAME

export interface PersistedSandboxBinding {
  sessionId: string
  sandboxName: string
  cwd: string
  workspaceRoot: string
  sourceRoot: string
  startedAt: number
  workspace: string
  environment: 'production' | 'development'
  provenance: SnapshotMeta
}

interface BindingDocument {
  version: typeof FORMAT_VERSION
  bindings: PersistedSandboxBinding[]
}

export function defaultBindingStorePath(): string {
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  return process.env.DSH_BLAXEL_BINDINGS_PATH ?? join(configHome, 'deepseek-harness', 'blaxel-sandbox-bindings.json')
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function absolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0') && isAbsolute(value)
}

function parseProvenance(value: unknown): SnapshotMeta | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  if (!absolutePath(item.repoRoot) || !absolutePath(item.cwd) || !absolutePath(item.remoteCwd)) return undefined
  if (!finiteNonNegative(item.fileCount) || !finiteNonNegative(item.skippedSensitive) || !finiteNonNegative(item.archiveBytes)) return undefined
  if (item.branch !== undefined && typeof item.branch !== 'string') return undefined
  if (item.commit !== undefined && typeof item.commit !== 'string') return undefined
  return {
    repoRoot: item.repoRoot,
    cwd: item.cwd,
    remoteCwd: item.remoteCwd,
    fileCount: item.fileCount,
    skippedSensitive: item.skippedSensitive,
    archiveBytes: item.archiveBytes,
    ...(typeof item.branch === 'string' ? { branch: item.branch } : {}),
    ...(typeof item.commit === 'string' ? { commit: item.commit } : {}),
  }
}

function parseBinding(value: unknown): PersistedSandboxBinding | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  const provenance = parseProvenance(item.provenance)
  if (typeof item.sessionId !== 'string' || !SESSION_ID.test(item.sessionId)) return undefined
  if (typeof item.sandboxName !== 'string' || !SANDBOX_NAME.test(item.sandboxName)) return undefined
  if (!absolutePath(item.cwd) || !absolutePath(item.workspaceRoot) || !absolutePath(item.sourceRoot)) return undefined
  if (!finiteNonNegative(item.startedAt) || typeof item.workspace !== 'string' || !WORKSPACE_NAME.test(item.workspace)) return undefined
  if (item.environment !== 'production' && item.environment !== 'development') return undefined
  if (provenance === undefined) return undefined
  return {
    sessionId: item.sessionId,
    sandboxName: item.sandboxName,
    cwd: item.cwd,
    workspaceRoot: item.workspaceRoot,
    sourceRoot: item.sourceRoot,
    startedAt: item.startedAt,
    workspace: item.workspace,
    environment: item.environment,
    provenance,
  }
}

export class SandboxBindingStore {
  private readonly bindings = new Map<string, PersistedSandboxBinding>()

  constructor(readonly path = defaultBindingStorePath()) {
    if (!existsSync(path)) return
    let value: unknown
    try {
      value = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      throw new Error(`Saved Blaxel sandbox bindings could not be read: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Saved Blaxel sandbox bindings are invalid')
    const document = value as Record<string, unknown>
    if (document.version !== FORMAT_VERSION || !Array.isArray(document.bindings)) throw new Error('Saved Blaxel sandbox bindings use an unsupported format')
    for (const candidate of document.bindings) {
      const binding = parseBinding(candidate)
      if (binding === undefined) throw new Error('Saved Blaxel sandbox bindings contain an invalid entry')
      if (this.bindings.has(binding.sessionId)) throw new Error('Saved Blaxel sandbox bindings contain a duplicate session')
      this.bindings.set(binding.sessionId, binding)
    }
  }

  list(): PersistedSandboxBinding[] {
    return [...this.bindings.values()]
  }

  get(sessionId: string): PersistedSandboxBinding | undefined {
    return this.bindings.get(sessionId)
  }

  save(binding: PersistedSandboxBinding): void {
    const previous = this.bindings.get(binding.sessionId)
    this.bindings.set(binding.sessionId, binding)
    try {
      this.flush()
    } catch (error) {
      if (previous === undefined) this.bindings.delete(binding.sessionId)
      else this.bindings.set(binding.sessionId, previous)
      throw error
    }
  }

  remove(sessionId: string): void {
    const previous = this.bindings.get(sessionId)
    if (previous === undefined) return
    this.bindings.delete(sessionId)
    try {
      this.flush()
    } catch (error) {
      this.bindings.set(sessionId, previous)
      throw error
    }
  }

  private flush(): void {
    const document: BindingDocument = { version: FORMAT_VERSION, bindings: this.list() }
    const directory = dirname(this.path)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${String(process.pid)}.${randomUUID()}.tmp`
    try {
      const descriptor = openSync(temporary, 'wx', 0o600)
      try {
        writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`)
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
      renameSync(temporary, this.path)
    } catch (error) {
      if (existsSync(temporary)) unlinkSync(temporary)
      throw error
    }
  }
}
