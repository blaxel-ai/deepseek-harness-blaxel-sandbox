import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createGitWorkspaceSnapshot,
  inspectGitWorkspace,
  removeGitWorkspaceSnapshot,
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
    await removeGitWorkspaceSnapshot(snapshot)
  })

  it('rejects directories outside a Git worktree', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-blaxel-random-test-'))
    cleanup.add(directory)
    await expect(inspectGitWorkspace(directory)).rejects.toThrow('Git worktree')
  })
})
