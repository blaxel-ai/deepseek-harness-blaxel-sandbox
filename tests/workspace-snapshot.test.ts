import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createGitWorkspaceSnapshot,
  inspectGitWorkspace,
  parseSnapshotMeta,
  removeGitWorkspaceSnapshot,
  snapshotMetaEnv,
} from '../src/web/workspace-snapshot.js'

const execFileAsync = promisify(execFile)
const cleanup = new Set<string>()

afterEach(async () => {
  await Promise.all([...cleanup].map(async path => await rm(path, { force: true, recursive: true })))
  cleanup.clear()
})

describe('Git workspace launch', () => {
  it('snapshots tracked and unignored files while excluding credential files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-blaxel-worktree-test-'))
    cleanup.add(root)
    await execFileAsync('git', ['init', '--quiet', root])
    await mkdir(join(root, 'packages', 'app'), { recursive: true })
    await writeFile(join(root, '.gitignore'), '*.log\n')
    await writeFile(join(root, 'packages', 'app', 'index.ts'), 'export const ready = true\n')
    await writeFile(join(root, '.env'), 'SECRET=do-not-copy\n')
    await writeFile(join(root, '.env.example'), 'SECRET=replace-me\n')
    await writeFile(join(root, 'ignored.log'), 'ignored\n')
    await execFileAsync('git', ['-C', root, 'add', '.gitignore', 'packages/app/index.ts', '.env.example'])
    await execFileAsync('git', ['-C', root, 'add', '--force', '.env'])

    const workspace = await inspectGitWorkspace(join(root, 'packages', 'app'))
    expect(workspace.repoRoot).toBe(await realpath(root))
    expect(workspace.remoteCwd).toBe('/workspace/packages/app')

    const snapshot = await createGitWorkspaceSnapshot(workspace)
    cleanup.add(snapshot.tempDir)
    expect(snapshot.skippedSensitive).toBe(1)
    const extracted = await mkdtemp(join(tmpdir(), 'dsh-blaxel-extract-test-'))
    cleanup.add(extracted)
    await execFileAsync('tar', ['-xzf', snapshot.archivePath, '-C', extracted])
    expect(await readFile(join(extracted, 'packages', 'app', 'index.ts'), 'utf8')).toContain('ready = true')
    expect(await readFile(join(extracted, '.env.example'), 'utf8')).toContain('replace-me')
    await expect(readFile(join(extracted, '.env'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(extracted, 'ignored.log'), 'utf8')).rejects.toThrow()
    const { stdout: entries } = await execFileAsync('tar', ['-tzf', snapshot.archivePath])
    expect(entries.split('\n').some(entry => entry.split('/').at(-1)?.startsWith('._') === true)).toBe(false)
    await removeGitWorkspaceSnapshot(snapshot)
  })

  it('rejects directories outside a Git worktree', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-blaxel-random-test-'))
    cleanup.add(directory)
    await expect(inspectGitWorkspace(directory)).rejects.toThrow('Git worktree')
  })
})

describe('snapshot provenance transport', () => {
  const snapshot = {
    cwd: '/repo/packages/app',
    repoRoot: '/repo',
    relativeCwd: 'packages/app',
    remoteCwd: '/workspace/packages/app',
    archivePath: '/tmp/dsh-blaxel-x/workspace.tar.gz',
    tempDir: '/tmp/dsh-blaxel-x',
    fileCount: 42,
    skippedSensitive: 2,
    archiveBytes: 4096,
    branch: 'main',
    commit: 'a'.repeat(40),
  }

  it('round-trips the provenance the child cannot compute itself', () => {
    expect(parseSnapshotMeta(snapshotMetaEnv(snapshot))).toEqual({
      repoRoot: '/repo',
      cwd: '/repo/packages/app',
      remoteCwd: '/workspace/packages/app',
      fileCount: 42,
      skippedSensitive: 2,
      archiveBytes: 4096,
      branch: 'main',
      commit: 'a'.repeat(40),
    })
  })

  it('omits Git facts that were unavailable at snapshot time', () => {
    const { branch: _branch, commit: _commit, ...detached } = snapshot
    expect(parseSnapshotMeta(snapshotMetaEnv(detached))).toMatchObject({ fileCount: 42 })
    expect(parseSnapshotMeta(snapshotMetaEnv(detached))?.branch).toBeUndefined()
  })

  it('rejects malformed, incomplete, and oversized provenance', () => {
    expect(parseSnapshotMeta(undefined)).toBeUndefined()
    expect(parseSnapshotMeta('not json')).toBeUndefined()
    expect(parseSnapshotMeta('[]')).toBeUndefined()
    expect(parseSnapshotMeta(JSON.stringify({ repoRoot: '/repo' }))).toBeUndefined()
    expect(parseSnapshotMeta(JSON.stringify({ ...snapshot, fileCount: -1 }))).toBeUndefined()
    expect(parseSnapshotMeta(JSON.stringify({ ...snapshot, cwd: 12 }))).toBeUndefined()
    expect(parseSnapshotMeta(`"${'x'.repeat(20_000)}"`)).toBeUndefined()
  })
})
