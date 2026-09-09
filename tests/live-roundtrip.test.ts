import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SandboxInstance } from '@blaxel/core'
import { BlaxelSessionRuntime } from '../src/session-runtime/service.js'
import { BlaxelDivergence } from '../src/web/divergence.js'
import { bootCloudHost, cloudRequest, waitForCloudHost } from '../src/cloud/bootstrap.js'
import { importSessionTail, sessionPrefixHash, validateSessionTransfer, withLocalPermissions } from '../src/cloud/session-transfer.js'

const exec = promisify(execFile)
const enabled = process.env.DSH_BLAXEL_LIVE === '1'

describe.skipIf(!enabled)('real session round trips and recovery', () => {
  let directory: string
  let repo: string
  const names = new Set<string>()
  const owners: Array<{ dispose(): Promise<unknown> }> = []
  const keys = ['DSH_BLAXEL_BINDINGS_PATH', 'XDG_CONFIG_HOME', 'DSH_BLAXEL_TTL', 'DSH_BLAXEL_REGION'] as const
  let previous: Record<string, string | undefined>

  beforeEach(async () => {
    previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
    directory = await mkdtemp(join(tmpdir(), 'dsh-live-roundtrip-'))
    repo = join(directory, 'project with spaces ü')
    await mkdir(join(repo, 'packages', 'app'), { recursive: true })
    process.env.DSH_BLAXEL_BINDINGS_PATH = join(directory, 'bindings.json')
    process.env.XDG_CONFIG_HOME = join(directory, 'config')
    process.env.DSH_BLAXEL_TTL = '10m'
    process.env.DSH_BLAXEL_REGION = process.env.BL_REGION ?? 'us-pdx-1'
    await exec('git', ['init', '--quiet', repo])
    await writeFile(join(repo, 'feature.txt'), 'before\n')
    await writeFile(join(repo, 'local.txt'), 'untouched\n')
    await writeFile(join(repo, '.gitignore'), '*.log\n')
    await writeFile(join(repo, '.env'), 'AUDIT_FAKE_SECRET=must-stay-local\n')
    await writeFile(join(repo, 'ignored.log'), 'not uploaded\n')
    await exec('git', ['-C', repo, 'add', 'feature.txt', 'local.txt', '.gitignore'])
    await exec('git', ['-C', repo, '-c', 'user.name=Audit', '-c', 'user.email=audit@example.invalid', 'commit', '--quiet', '-m', 'baseline'])
  })

  afterEach(async () => {
    try {
      for (const name of names) {
        const sandbox = await SandboxInstance.get(name).catch((error: unknown) => {
          if (typeof error === 'object' && error !== null && 'code' in error && error.code === 404) return undefined
          throw error
        })
        if (sandbox === undefined) continue
        if (!/^(TERMINATED|DELETING|TERMINATING)$/.test(String(sandbox.status))) await sandbox.delete()
        const remaining = await SandboxInstance.get(name).catch((error: unknown) => {
          if (typeof error === 'object' && error !== null && 'code' in error && error.code === 404) return undefined
          throw error
        })
        expect(remaining === undefined || /^(TERMINATED|DELETING|TERMINATING)$/.test(String(remaining.status))).toBe(true)
      }
    } finally {
      names.clear()
      for (const owner of owners.splice(0).reverse()) await owner.dispose()
      await rm(directory, { recursive: true, force: true })
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key]
        else process.env[key] = previous[key]
      }
    }
  }, 60_000)

  async function host(): Promise<BlaxelSessionRuntime> {
    const ctx = new Context()
    owners.push(await ctx.plugin(BlaxelSessionRuntime))
    await ctx.blaxelSessions.status()
    return ctx.blaxelSessions
  }

  it('boots a private native cloud host, freezes its history and draft, and returns its files', async () => {
    const sessions = await host()
    const prepared = await sessions.prepare(repo, 'move', true)
    names.add(prepared.runtime.name)
    const remote = await sessions.bind(prepared, 'live-cloud-session')
    const sandbox = await remote.runtime.getSandbox()
    const local = Session.create(SessionId('live-cloud-session'))
    local.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep this conversation on the cloud host' }] }), { surfaceOp: 'append' })
    const initial = local.snapshotEvents()
    const draft = { text: 'Unsent instructions survive the round trip', images: [] }
    const controlToken = randomBytes(32).toString('hex')
    await bootCloudHost(sandbox, {
      session: { meta: { ...local.header, cwd: '/workspace' }, events: initial, inheritedEventCount: local.inheritedEventCount },
      localOrigin: 'http://127.0.0.1:51824', sandboxName: remote.runtime.name, workspace: remote.workspace,
      draft: { revision: 'seed', draft },
    }, {}, { DSH_BLAXEL_CONTROL_TOKEN: controlToken })
    await waitForCloudHost(sandbox, controlToken)
    await cloudRequest(sandbox, controlToken, 'start')
    const opened = await cloudRequest(sandbox, controlToken, 'open')
    const address = new URL(String(opened.url))
    // Never put the private address in assertion output or persisted artifacts.
    expect((await fetch(address.origin, { signal: AbortSignal.timeout(30_000) })).status).toBe(401)
    const forged = await fetch(address.origin, { signal: AbortSignal.timeout(30_000), headers: {
      'x-forwarded-host': address.host, 'x-forwarded-proto': 'https',
      'x-blaxel-auth-method': 'preview_token', 'x-blaxel-subject-type': 'preview_token',
      'x-blaxel-subject-id': `preview:${address.hostname.split('.')[0]}`,
      'x-blaxel-workload-type': 'sandboxes', 'x-blaxel-workload': remote.runtime.name, 'x-blaxel-workspace': remote.workspace,
    } })
    expect(forged.status).toBe(401)
    const login = await fetch(address, { signal: AbortSignal.timeout(30_000), redirect: 'manual' })
    expect(login.status).toBe(200)
    expect(login.headers.get('content-type')).toContain('text/html')
    address.pathname = '/blaxel/api/mode'
    const mode = await fetch(address, { signal: AbortSignal.timeout(30_000) })
    expect(mode.status).toBe(200)
    expect(await mode.json()).toMatchObject({ ok: true, mode: 'cloud', sessionId: local.id })
    // Exercise the installed native Linux subprocess runtime after --ignore-scripts.
    // Synthetic values only: never print the host environment or real credentials.
    await sandbox.fs.write('/opt/dsh-blaxel/runtime/check-subprocess.mjs', `
      import { Context } from '@deepseek-ai/cordis';
      import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local';
      const ctx = new Context();
      const owner = await ctx.plugin(LocalSubprocessRuntime);
      const keys = ['DSH_BLAXEL_MODEL_KEY', 'DSH_BLAXEL_CONTROL_TOKEN', 'DSH_BLAXEL_BROWSER_TOKEN'];
      for (const key of keys) process.env[key] = 'synthetic-test-value';
      try {
        const child = ctx.subprocess.spawn({ argv: [process.execPath, '-e', 'process.exit(' + JSON.stringify(keys) + '.every(k => process.env[k] === undefined) ? 0 : 1)'], cwd: '/workspace', stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 1000 });
        if ((await child.done).exitCode !== 0) throw new Error('Native child environment check failed');
        const terminal = await ctx.subprocess.spawnTerminal({ argv: ['/bin/sh', '-c', 'exit 0'], cwd: '/workspace', rows: 24, cols: 80, graceMs: 1000 });
        if ((await terminal.done).exitCode !== 0) throw new Error('Native terminal check failed');
      } finally { await owner.dispose(); }
    `)
    expect((await sandbox.process.exec({ command: 'node /opt/dsh-blaxel/runtime/check-subprocess.mjs', workingDir: '/opt/dsh-blaxel/runtime', waitForCompletion: true, timeout: 30 })).exitCode).toBe(0)
    await remote.fs.writeText(await remote.fs.resolve('feature.txt'), 'cloud host round trip\n')
    const frozen = await cloudRequest(sandbox, controlToken, 'freeze')
    expect(frozen.draft).toMatchObject({ draft })
    expect((await cloudRequest(sandbox, controlToken, 'freeze')).session).toEqual(frozen.session)
    const transferred = withLocalPermissions(validateSessionTransfer(frozen.session, local.id), initial, { sandbox: 'workspace-write', approval: 'ask', preset: 'workspace-write' })
    importSessionTail(local, transferred, initial.length, sessionPrefixHash(initial))
    expect(local.snapshotEvents()).toEqual(transferred.events)
    await sessions.moveChangesLocal(local.id)
    expect(await readFile(join(repo, 'feature.txt'), 'utf8')).toBe('cloud host round trip\n')
    expect(sessions.isSandboxSession(local.id)).toBe(false)
  }, 480_000)

  it('reports agent commits against the original snapshot and preserves host edits on return', async () => {
    const sessions = await host()
    const prepared = await sessions.prepare(join(repo, 'packages', 'app'), 'move')
    names.add(prepared.runtime.name)
    const session = await sessions.bind(prepared, 'audit-commits')
    const sandbox = await session.runtime.getSandbox()
    expect(session.runtime.cwd).toBe('/workspace/packages/app')
    expect((await sandbox.process.exec({ command: 'test ! -e /workspace/.env && test ! -e /workspace/ignored.log', waitForCompletion: true })).exitCode).toBe(0)
    await session.fs.writeText(await session.fs.resolve(join(repo, 'feature.txt')), 'committed remotely\n')
    expect((await sandbox.process.exec({
      command: "git add feature.txt && git -c user.name=Audit -c user.email=audit@example.invalid commit --quiet -m change",
      workingDir: '/workspace', waitForCompletion: true,
    })).exitCode).toBe(0)
    const report = await new BlaxelDivergence(session.runtime).read()
    expect(report).toMatchObject({ available: true, divergence: { changed: 1, files: [{ path: 'feature.txt' }] } })
    await writeFile(join(repo, 'local.txt'), 'new host edit\n')
    await sessions.moveChangesLocal('audit-commits')
    expect(await readFile(join(repo, 'feature.txt'), 'utf8')).toBe('committed remotely\n')
    expect(await readFile(join(repo, 'local.txt'), 'utf8')).toBe('new host edit\n')
    expect(await readFile(join(repo, '.env'), 'utf8')).toContain('must-stay-local')
    expect(sessions.isSandboxSession('audit-commits')).toBe(false)
  }, 180_000)

  it('preserves conflicting work across a host restart, then requires consent after actual deletion', async () => {
    let sessions = await host()
    const prepared = await sessions.prepare(repo, 'move')
    names.add(prepared.runtime.name)
    let session = await sessions.bind(prepared, 'audit-recovery')
    const name = session.runtime.name
    await session.fs.writeText(await session.fs.resolve('feature.txt'), 'sandbox work\n')
    await writeFile(join(repo, 'feature.txt'), 'host work\n')
    await expect(sessions.moveChangesLocal('audit-recovery')).rejects.toThrow('nothing was applied')
    expect(await readFile(join(repo, 'feature.txt'), 'utf8')).toBe('host work\n')
    expect(await session.fs.readText(await session.fs.resolve('feature.txt'))).toBe('sandbox work\n')
    await owners.pop()?.dispose()
    sessions = await host()
    session = sessions.get('audit-recovery')!
    expect(session.runtime.name).toBe(name)
    expect(await session.fs.readText(await session.fs.resolve('feature.txt'))).toBe('sandbox work\n')
    expect(await session.runtime.markUnavailable({ code: 404, message: 'Process not found' })).toBe(false)
    expect(session.runtime.phase).toBe('ready')
    await (await session.runtime.getSandbox()).delete()
    await session.runtime.probe(Date.now(), true)
    expect((await sessions.status()).sandboxes[0]?.state).toBe('failed')
    await expect(sessions.reconnect('audit-recovery')).resolves.toBe('missing')
    expect(sessions.isSandboxSession('audit-recovery')).toBe(true)
    await sessions.recreateMissing('audit-recovery')
    session = sessions.get('audit-recovery')!
    names.add(session.runtime.name)
    expect(session.runtime.name).not.toBe(name)
    expect(await session.fs.readText(await session.fs.resolve('feature.txt'))).toBe('host work\n')
    await sessions.close('audit-recovery')
    expect(sessions.isSandboxSession('audit-recovery')).toBe(false)
  }, 240_000)
})
