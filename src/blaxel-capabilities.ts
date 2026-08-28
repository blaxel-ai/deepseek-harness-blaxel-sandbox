import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'

const runFile = promisify(execFile)
const require = createRequire(import.meta.url)
const MCP_ENDPOINT = 'https://api.blaxel.ai/v0/mcp'
const MCP_PROFILE = 'blaxel'
const MCP_SESSION = '@blaxel-dsh'
const MCP_PROXY = '127.0.0.1:31568'
const MCP_PROXY_URL = `http://${MCP_PROXY}`
const CORE_SKILLS = ['blaxel-cli', 'blaxel-sdk'] as const

interface SavedCapabilities {
  mcp?: { enabled: boolean; proxyBearerToken: string }
}

export interface BlaxelCapabilitiesStatus {
  skills: { installed: boolean; upToDate?: boolean; names: string[]; checkError?: string }
  mcp: { connected: boolean; endpoint: string }
}

interface SkillLockEntry {
  skillFolderHash?: unknown
  skillPath?: unknown
  source?: unknown
  sourceType?: unknown
}

interface SkillLock {
  skills?: Record<string, SkillLockEntry>
}

function capabilitiesPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  return join(configHome, 'deepseek-harness', 'blaxel-capabilities.json')
}

function packageBin(packageName: string, relativePath: string): string {
  return join(dirname(require.resolve(`${packageName}/package.json`)), relativePath)
}

export function safeCapabilityCommandError(error: unknown, redactions: readonly string[] = []): Error {
  if (typeof error !== 'object' || error === null) return new Error('The capability command failed')
  const candidate = error as { stderr?: unknown; message?: unknown }
  const detail = typeof candidate.stderr === 'string' && candidate.stderr.trim() !== ''
    ? candidate.stderr.trim().split('\n').at(-1)
    : typeof candidate.message === 'string' ? candidate.message : undefined
  let safe = detail?.replaceAll(/Bearer\s+\S+/gi, 'Bearer [redacted]') ?? 'The capability command failed'
  for (const redaction of redactions) {
    if (redaction !== '') safe = safe.replaceAll(redaction, '[redacted]')
  }
  return new Error(safe)
}

function commandRedactions(args: readonly string[]): string[] {
  return args.flatMap((arg, index) => arg === '--proxy-bearer-token' && args[index + 1] !== undefined ? [args[index + 1]] : [])
}

export class BlaxelCapabilitiesManager {
  private mcpFiber?: Fiber
  private restoring?: Promise<void>
  private skillFreshnessCache?: { expiresAt: number; value: Pick<BlaxelCapabilitiesStatus['skills'], 'upToDate' | 'checkError'> }

  constructor(private readonly ctx: Context, private readonly path = capabilitiesPath()) {}

  restore(): Promise<void> {
    this.restoring ??= this.restoreSaved().catch(error => {
      this.ctx.logger.warn(`blaxel capabilities: ${error instanceof Error ? error.message : String(error)}`)
    })
    return this.restoring
  }

  async status(): Promise<BlaxelCapabilitiesStatus> {
    const installed = await Promise.all(CORE_SKILLS.map(async name => {
      try {
        await access(join(homedir(), '.agents', 'skills', name, 'SKILL.md'))
        return name
      } catch {
        return undefined
      }
    }))
    const saved = await this.read()
    const installedNames = installed.filter((name): name is typeof CORE_SKILLS[number] => name !== undefined)
    const freshness = installed.every(Boolean) ? await this.skillFreshness() : {}
    return {
      skills: { installed: installed.every(Boolean), names: installedNames, ...freshness },
      mcp: { connected: saved.mcp?.enabled === true && this.mcpFiber !== undefined, endpoint: MCP_ENDPOINT },
    }
  }

  async installSkills(): Promise<BlaxelCapabilitiesStatus> {
    await this.runNode(packageBin('skills', 'bin/cli.mjs'), [
      'add',
      'blaxel-ai/agent-skills',
      '--global',
      '--all',
      '--copy',
    ], 180_000)
    this.skillFreshnessCache = undefined
    return await this.status()
  }

  async connectMcp(): Promise<BlaxelCapabilitiesStatus> {
    await this.runMcpc(['login', MCP_ENDPOINT, '--profile', MCP_PROFILE, '--no-client-metadata-url'], 5 * 60_000)
    const saved = await this.read()
    const proxyBearerToken = saved.mcp?.proxyBearerToken ?? randomBytes(32).toString('base64url')
    await this.startProxy(proxyBearerToken)
    await this.save({ ...saved, mcp: { enabled: true, proxyBearerToken } })
    await this.mountMcp(proxyBearerToken)
    return await this.status()
  }

  async disconnectMcp(): Promise<BlaxelCapabilitiesStatus> {
    await this.mcpFiber?.dispose()
    this.mcpFiber = undefined
    await this.runMcpc(['close', MCP_SESSION], 30_000, true)
    await this.runMcpc(['logout', MCP_ENDPOINT, '--profile', MCP_PROFILE], 30_000, true)
    await this.save({})
    return await this.status()
  }

  async dispose(): Promise<void> {
    await this.mcpFiber?.dispose().catch(() => undefined)
    this.mcpFiber = undefined
    await this.runMcpc(['close', MCP_SESSION], 30_000, true)
  }

  private async restoreSaved(): Promise<void> {
    const saved = await this.read()
    if (saved.mcp?.enabled !== true) return
    await this.startProxy(saved.mcp.proxyBearerToken)
    await this.mountMcp(saved.mcp.proxyBearerToken)
  }

  private async startProxy(proxyBearerToken: string): Promise<void> {
    await this.runMcpc(['close', MCP_SESSION], 30_000, true)
    await this.runMcpc([
      'connect',
      MCP_ENDPOINT,
      MCP_SESSION,
      '--profile',
      MCP_PROFILE,
      '--proxy',
      MCP_PROXY,
      '--proxy-bearer-token',
      proxyBearerToken,
      '--json',
    ], 60_000)
  }

  private async mountMcp(proxyBearerToken: string): Promise<void> {
    if (this.mcpFiber !== undefined) return
    this.mcpFiber = await this.ctx.plugin(McpClient, {
      transport: 'streamable-http',
      serverName: 'blaxel',
      url: MCP_PROXY_URL,
      headers: { authorization: `Bearer ${proxyBearerToken}` },
      toolCallTimeoutMs: 60_000,
      failOnStartupError: true,
    })
  }

  private async read(): Promise<SavedCapabilities> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
      const candidate = value as SavedCapabilities
      if (candidate.mcp?.enabled === true && typeof candidate.mcp.proxyBearerToken === 'string' && candidate.mcp.proxyBearerToken.length >= 32) return candidate
      return {}
    } catch {
      return {}
    }
  }

  private async skillFreshness(): Promise<Pick<BlaxelCapabilitiesStatus['skills'], 'upToDate' | 'checkError'>> {
    if (this.skillFreshnessCache !== undefined && this.skillFreshnessCache.expiresAt > Date.now()) return this.skillFreshnessCache.value
    let value: Pick<BlaxelCapabilitiesStatus['skills'], 'upToDate' | 'checkError'>
    try {
      const lockValue: unknown = JSON.parse(await readFile(join(homedir(), '.agents', '.skill-lock.json'), 'utf8'))
      const lock = typeof lockValue === 'object' && lockValue !== null ? lockValue as SkillLock : {}
      const entries = CORE_SKILLS.map(name => lock.skills?.[name])
      if (entries.some(entry => entry?.source !== 'blaxel-ai/agent-skills' || entry.sourceType !== 'github' || typeof entry.skillPath !== 'string' || typeof entry.skillFolderHash !== 'string')) {
        throw new Error('Update status is unavailable')
      }
      const response = await fetch('https://api.github.com/repos/blaxel-ai/agent-skills/git/trees/HEAD?recursive=1', {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'deepseek-harness-blaxel' },
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error('Update check failed')
      const body: unknown = await response.json()
      const tree = typeof body === 'object' && body !== null && Array.isArray((body as { tree?: unknown }).tree)
        ? (body as { tree: Array<{ path?: unknown; sha?: unknown; type?: unknown }> }).tree
        : []
      const upToDate = entries.every(entry => {
        if (typeof entry?.skillPath !== 'string' || typeof entry.skillFolderHash !== 'string') return false
        const folder = entry.skillPath.replace(/\/SKILL\.md$/i, '')
        const remote = tree.find(item => item.type === 'tree' && item.path === folder)
        return typeof remote?.sha === 'string' && remote.sha === entry.skillFolderHash
      })
      value = { upToDate }
    } catch (error) {
      value = { checkError: error instanceof Error ? error.message : 'Update check failed' }
    }
    this.skillFreshnessCache = { expiresAt: Date.now() + 5 * 60_000, value }
    return value
  }

  private async save(value: SavedCapabilities): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${String(process.pid)}.tmp`
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.path)
  }

  private async runMcpc(args: string[], timeout: number, ignoreFailure = false): Promise<void> {
    try {
      await this.runNode(packageBin('@apify/mcpc', 'bin/mcpc'), args, timeout)
    } catch (error) {
      if (!ignoreFailure) throw error
    }
  }

  private async runNode(script: string, args: string[], timeout: number): Promise<void> {
    try {
      await runFile(process.execPath, [script, ...args], { timeout, maxBuffer: 2 * 1024 * 1024 })
    } catch (error) {
      throw safeCapabilityCommandError(error, commandRedactions(args))
    }
  }
}
