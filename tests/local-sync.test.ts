import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
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

  it('treats an already-applied sandbox patch as a successful retry', async () => {
    const root = await repository()
    const patch = {
      commit: 'sandbox-baseline',
      text: 'diff --git a/feature.txt b/feature.txt\nindex 9c59e24..f2f0e75 100644\n--- a/feature.txt\n+++ b/feature.txt\n@@ -1 +1 @@\n-before\n+after\n',
      bytes: 139,
      truncated: false,
      checkedAt: new Date().toISOString(),
    }
    await applySandboxPatch(root, patch)
    await expect(applySandboxPatch(root, patch)).resolves.toBeUndefined()
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

  it('rejects a guest-created symbolic link without changing the worktree', async () => {
    const root = await repository()
    const text = 'diff --git a/id_rsa b/id_rsa\nnew file mode 0120000 extra\nindex 0000000..3594e94\n--- /dev/null\n+++ b/id_rsa\n@@ -0,0 +1 @@\n+/etc/passwd\n\\ No newline at end of file\n'

    await expect(applySandboxPatch(root, {
      commit: 'sandbox-baseline', text, bytes: Buffer.byteLength(text), truncated: false, checkedAt: new Date().toISOString(),
    })).rejects.toThrow('symbolic link')
    await expect(readFile(join(root, 'id_rsa'), 'utf8')).rejects.toThrow()
  })

  it('rejects rewriting an existing symbolic link target', async () => {
    const root = await repository()
    const text = 'diff --git a/link b/link\nindex 67be85f..3594e94 00120000 unexpected\n--- a/link\n+++ b/link\n@@ -1 +1 @@\n-feature.txt\n\\ No newline at end of file\n+/etc/passwd\n\\ No newline at end of file\n'

    await expect(applySandboxPatch(root, {
      commit: 'sandbox-baseline', text, bytes: Buffer.byteLength(text), truncated: false, checkedAt: new Date().toISOString(),
    })).rejects.toThrow('symbolic link')
  })

  it('rejects a content-only patch targeting an existing host symbolic link', async () => {
    const root = await repository()
    await symlink('feature.txt', join(root, 'link'))
    await execFileAsync('git', ['-C', root, 'add', 'link'])
    await execFileAsync('git', ['-C', root, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'add link'])
    const text = 'diff --git a/link b/link\n--- a/link\n+++ b/link\n@@ -1 +1 @@\n-feature.txt\n+/etc/passwd\n'

    await expect(applySandboxPatch(root, {
      commit: 'sandbox-baseline', text, bytes: Buffer.byteLength(text), truncated: false, checkedAt: new Date().toISOString(),
    })).rejects.toThrow('symbolic link')
    expect(await readlink(join(root, 'link'))).toBe('feature.txt')
  })

  it('rejects copy metadata that could inherit a host symbolic-link mode', async () => {
    const root = await repository()
    await symlink('feature.txt', join(root, 'link'))
    await execFileAsync('git', ['-C', root, 'add', 'link'])
    await execFileAsync('git', ['-C', root, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'add link'])
    const text = 'diff --git a/link b/id_rsa\nsimilarity index 100%\ncopy from link\ncopy to id_rsa\n'

    await expect(applySandboxPatch(root, {
      commit: 'sandbox-baseline', text, bytes: Buffer.byteLength(text), truncated: false, checkedAt: new Date().toISOString(),
    })).rejects.toThrow('copy or rename')
    await expect(readFile(join(root, 'id_rsa'), 'utf8')).rejects.toThrow()
  })

  it('does not apply a path-changing diff without transfer metadata from a host symbolic link', async () => {
    const root = await repository()
    await symlink('feature.txt', join(root, 'link'))
    await execFileAsync('git', ['-C', root, 'add', 'link'])
    await execFileAsync('git', ['-C', root, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'add link'])
    const text = 'diff --git a/link b/id_rsa\n--- a/link\n+++ b/id_rsa\n@@ -1 +1 @@\n-feature.txt\n+/etc/passwd\n'

    await expect(applySandboxPatch(root, {
      commit: 'sandbox-baseline', text, bytes: Buffer.byteLength(text), truncated: false, checkedAt: new Date().toISOString(),
    })).rejects.toThrow()
    await expect(readFile(join(root, 'id_rsa'), 'utf8')).rejects.toThrow()
    expect(await readlink(join(root, 'link'))).toBe('feature.txt')
  })
})

/** A worktree that looks like a real project: text, binary, nested unicode paths, a script. */
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-blaxel-project-'))
  roots.push(root)
  await execFileAsync('git', ['-C', root, 'init', '--quiet'])
  await writeFile(join(root, 'feature.txt'), 'before\n')
  await writeFile(join(root, 'notes.txt'), Array.from({ length: 30 }, (_, index) => `line ${String(index + 1)}`).join('\n') + '\n')
  await writeFile(join(root, 'logo.bin'), Buffer.from(Array.from({ length: 256 }, (_, index) => index)))
  await writeFile(join(root, 'tool.sh'), '#!/bin/sh\necho tool\n')
  await mkdir(join(root, 'docs'))
  await writeFile(join(root, 'docs', 'read me ü.md'), '# Notes\n')
  await execFileAsync('git', ['-C', root, 'add', '-A'])
  await execFileAsync('git', ['-C', root, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'baseline'])
  return root
}

/** Produces the patch exactly as the sandbox does: clone the baseline, mutate, `add -N`, binary diff against the baseline commit. */
async function sandboxPatch(root: string, mutate: (sandbox: string) => Promise<void>): Promise<Parameters<typeof applySandboxPatch>[1]> {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-blaxel-sandbox-copy-'))
  roots.push(sandbox)
  await execFileAsync('git', ['clone', '--quiet', root, sandbox])
  await mutate(sandbox)
  await execFileAsync('git', ['-C', sandbox, 'add', '-A', '-N'])
  const { stdout } = await execFileAsync('git', ['-C', sandbox, 'diff', '--binary', '--no-renames', 'HEAD'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  return { commit: 'sandbox-baseline', text: stdout, bytes: Buffer.byteLength(stdout), truncated: false, checkedAt: '2026-09-04T10:00:00.000Z' }
}

async function commitAll(root: string, message: string): Promise<void> {
  await execFileAsync('git', ['-C', root, 'add', '-A'])
  await execFileAsync('git', ['-C', root, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', message])
}

describe('returning home: local work and sandbox work meet', () => {
  it('keeps new local edits to files the sandbox never touched', async () => {
    const root = await project()
    const patch = await sandboxPatch(root, async sandbox => { await writeFile(join(sandbox, 'feature.txt'), 'after\n') })
    await writeFile(join(root, 'notes.txt'), 'local rewrite\n')

    await applySandboxPatch(root, patch)

    expect(await readFile(join(root, 'feature.txt'), 'utf8')).toBe('after\n')
    expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('local rewrite\n')
  })

  it('merges sandbox and local edits to different regions of the same file', async () => {
    const root = await project()
    const patch = await sandboxPatch(root, async sandbox => {
      const text = await readFile(join(sandbox, 'notes.txt'), 'utf8')
      await writeFile(join(sandbox, 'notes.txt'), text.replace('line 2\n', 'line 2 (sandbox)\n'))
    })
    const local = await readFile(join(root, 'notes.txt'), 'utf8')
    await writeFile(join(root, 'notes.txt'), local.replace('line 29\n', 'line 29 (local)\n'))

    await applySandboxPatch(root, patch)

    const merged = await readFile(join(root, 'notes.txt'), 'utf8')
    expect(merged).toContain('line 2 (sandbox)\n')
    expect(merged).toContain('line 29 (local)\n')
  })

  it('still applies after local commits moved HEAD past the snapshot', async () => {
    const root = await project()
    const patch = await sandboxPatch(root, async sandbox => { await writeFile(join(sandbox, 'feature.txt'), 'after\n') })
    await writeFile(join(root, 'notes.txt'), 'committed at home\n')
    await commitAll(root, 'home work')

    await applySandboxPatch(root, patch)

    expect(await readFile(join(root, 'feature.txt'), 'utf8')).toBe('after\n')
    expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('committed at home\n')
  })

  it('refuses when both sides created the same new file, and keeps the sandbox patch for manual merge', async () => {
    const root = await project()
    const patch = await sandboxPatch(root, async sandbox => { await writeFile(join(sandbox, 'new.txt'), 'sandbox version\n') })
    await writeFile(join(root, 'new.txt'), 'local version\n')

    const failure = await applySandboxPatch(root, patch).then(() => new Error('unexpectedly applied'), (error: unknown) => error as Error)

    expect(failure.message).toContain('nothing was applied')
    expect(failure.message).toContain('git apply --3way')
    expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('local version\n')
    const saved = /saved to (\S+\.patch)/.exec(failure.message)?.[1]
    expect(saved).toBeDefined()
    expect(saved).toContain(join(root, '.git', 'dsh-blaxel'))
    expect(await readFile(saved as string, 'utf8')).toBe(patch.text)
    const { stdout } = await execFileAsync('git', ['-C', root, 'status', '--porcelain'])
    expect(stdout).toBe('?? new.txt\n')
  })

  it('refuses when the same lines changed on both sides and names the file', async () => {
    const root = await project()
    const patch = await sandboxPatch(root, async sandbox => { await writeFile(join(sandbox, 'feature.txt'), 'sandbox\n') })
    await writeFile(join(root, 'feature.txt'), 'home\n')

    await expect(applySandboxPatch(root, patch)).rejects.toThrow(/feature\.txt.*nothing was applied|nothing was applied.*feature\.txt/s)
    expect(await readFile(join(root, 'feature.txt'), 'utf8')).toBe('home\n')
  })

  it('applies a sandbox deletion when the file is unchanged locally', async () => {
    const root = await project()
    const patch = await sandboxPatch(root, async sandbox => { await rm(join(sandbox, 'tool.sh')) })

    await applySandboxPatch(root, patch)

    await expect(readFile(join(root, 'tool.sh'))).rejects.toThrow()
  })

  it('refuses a sandbox deletion of a file edited locally', async () => {
    const root = await project()
    const patch = await sandboxPatch(root, async sandbox => { await rm(join(sandbox, 'tool.sh')) })
    await writeFile(join(root, 'tool.sh'), '#!/bin/sh\necho edited at home\n')

    await expect(applySandboxPatch(root, patch)).rejects.toThrow('nothing was applied')
    expect(await readFile(join(root, 'tool.sh'), 'utf8')).toBe('#!/bin/sh\necho edited at home\n')
  })

  it('transfers binary changes byte for byte', async () => {
    const root = await project()
    const bytes = Buffer.from(Array.from({ length: 512 }, (_, index) => (index * 7) % 256))
    const patch = await sandboxPatch(root, async sandbox => { await writeFile(join(sandbox, 'logo.bin'), bytes) })

    await applySandboxPatch(root, patch)

    expect(Buffer.compare(await readFile(join(root, 'logo.bin')), bytes)).toBe(0)
  })

  it('handles paths with spaces and non-ASCII characters', async () => {
    const root = await project()
    const patch = await sandboxPatch(root, async sandbox => {
      await writeFile(join(sandbox, 'docs', 'read me ü.md'), '# Notes\n\nWritten in the sandbox.\n')
      await mkdir(join(sandbox, 'dir with space'))
      await writeFile(join(sandbox, 'dir with space', 'nëw file.txt'), 'hello\n')
    })

    await applySandboxPatch(root, patch)

    expect(await readFile(join(root, 'docs', 'read me ü.md'), 'utf8')).toContain('Written in the sandbox.')
    expect(await readFile(join(root, 'dir with space', 'nëw file.txt'), 'utf8')).toBe('hello\n')
  })

  it('carries an executable bit set in the sandbox', async () => {
    const root = await project()
    const patch = await sandboxPatch(root, async sandbox => { await chmod(join(sandbox, 'tool.sh'), 0o755) })

    await applySandboxPatch(root, patch)

    expect((await stat(join(root, 'tool.sh'))).mode & 0o111).not.toBe(0)
  })

  it('fails closed when the original worktree no longer exists', async () => {
    const root = await project()
    const patch = await sandboxPatch(root, async sandbox => { await writeFile(join(sandbox, 'feature.txt'), 'after\n') })
    await rm(root, { force: true, recursive: true })

    await expect(applySandboxPatch(root, patch)).rejects.toThrow('no longer exists')
  })
})
