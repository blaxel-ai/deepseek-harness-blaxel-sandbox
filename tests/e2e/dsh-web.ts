import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

export interface DshWeb {
  url: string
  stop(): Promise<void>
}

/**
 * A fresh DSH profile (CI) has no workspace, so the composer never mounts and
 * "Add workspace" opens a native folder picker. Seed the repository as the only
 * workspace; a profile that already has workspaces is left untouched.
 */
function seedWorkspace(): void {
  const storages = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages')
  const file = join(storages, 'workspace.json')
  const existing = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as { global?: { workspaceIds?: string[] } } : undefined
  if ((existing?.global?.workspaceIds?.length ?? 0) > 0) return
  const id = randomUUID()
  const now = new Date().toISOString()
  mkdirSync(storages, { recursive: true })
  writeFileSync(file, JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [id], archivedSessionIds: [] },
    tables: { workspaces: { [id]: { path: process.cwd(), title: basename(process.cwd()), sessionIds: [], createdAt: now, updatedAt: now } } },
  }, null, 2))
}

/** Starts `dsh web` on a free port and resolves once it prints its tokenised URL. */
export async function startDshWeb(): Promise<DshWeb> {
  seedWorkspace()
  const child: ChildProcess = spawn('dsh', ['web', '--no-open', '--port', '0'], {
    detached: true,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dsh web did not start in time:\n${output}`)), 60_000)
    const watch = (chunk: Buffer): void => {
      output += chunk.toString()
      const match = /dsh web: (\S+)/.exec(output)
      if (match?.[1] !== undefined) {
        clearTimeout(timer)
        resolve(match[1])
      }
    }
    child.stdout?.on('data', watch)
    child.stderr?.on('data', watch)
    child.once('exit', code => {
      clearTimeout(timer)
      reject(new Error(`dsh web exited with ${String(code)}:\n${output}`))
    })
  })
  return {
    url,
    stop: () => new Promise(resolve => {
      child.once('exit', () => resolve())
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
      }
      setTimeout(resolve, 5_000).unref()
    }),
  }
}
