import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { applySandboxPatch } from '../src/web/local-sync.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-blaxel-sync-test-'))
  roots.push(root)
  await execFileAsync('git', ['-C', root, 'init', '--quiet'])
  await writeFile(join(root, 'feature.txt'), 'before\n')
  await execFileAsync('git', ['-C', root, 'add', 'feature.txt'])
  await execFileAsync('git', ['-C', root, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'baseline'])
  return root
}

describe('moving sandbox changes locally', () => {
  it('applies a checked patch to the original worktree', async () => {
    const root = await repository()
    await applySandboxPatch(root, {
      commit: 'sandbox-baseline',
      text: 'diff --git a/feature.txt b/feature.txt\nindex 9c59e24..f2f0e75 100644\n--- a/feature.txt\n+++ b/feature.txt\n@@ -1 +1 @@\n-before\n+after\n',
      bytes: 139,
      truncated: false,
      checkedAt: new Date().toISOString(),
    })
    expect(await readFile(join(root, 'feature.txt'), 'utf8')).toBe('after\n')
  })

  it('leaves a conflicting local file untouched', async () => {
    const root = await repository()
    await writeFile(join(root, 'feature.txt'), 'local edit\n')
    const patch = {
      commit: 'sandbox-baseline',
      text: 'diff --git a/feature.txt b/feature.txt\nindex 9c59e24..f2f0e75 100644\n--- a/feature.txt\n+++ b/feature.txt\n@@ -1 +1 @@\n-before\n+after\n',
      bytes: 139,
      truncated: false,
      checkedAt: new Date().toISOString(),
    }
    await expect(applySandboxPatch(root, patch)).rejects.toThrow('nothing was applied')
    expect(await readFile(join(root, 'feature.txt'), 'utf8')).toBe('local edit\n')
  })

  it('rejects a truncated patch', async () => {
    const root = await repository()
    await expect(applySandboxPatch(root, {
      commit: 'sandbox-baseline', text: 'partial', bytes: 7, truncated: true, checkedAt: new Date().toISOString(),
    })).rejects.toThrow('1 MiB')
  })
})
