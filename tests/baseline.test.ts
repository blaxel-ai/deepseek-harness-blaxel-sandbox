import type { SandboxInstance } from '@blaxel/core'
import { describe, expect, it, vi } from 'vitest'
import { createBaseline, restoreBaseline } from '../src/runtime/baseline.js'
import type { RuntimePaths } from '../src/runtime/paths.js'

const commit = 'a'.repeat(40)
const paths: RuntimePaths = {
  cwd: '/workspace/project',
  workspaceRoot: '/workspace',
  sourceRoot: '/Users/test/project',
  runtimeRoot: '/workspace/.dsh-blaxel',
}

function sandboxWith(exec: ReturnType<typeof vi.fn>): SandboxInstance {
  return { process: { exec } } as unknown as SandboxInstance
}

describe('divergence baseline lifecycle', () => {
  it('creates the baseline once before sandbox tools become ready', async () => {
    const exec = vi.fn(async (_request: { command: string }) => ({ exitCode: 0, stdout: commit, stderr: '', logs: '' }))

    await expect(createBaseline(sandboxWith(exec), paths)).resolves.toEqual({ ready: true, commit })

    const command = String(exec.mock.calls[0]?.[0]?.command)
    expect(command).toContain('bash -o pipefail -c')
    expect(command).toContain('git init --quiet --bare')
    expect(command).toContain('config core.bare false')
    expect(command).toMatch(/\{ test -d \S*\/workspace\/\.git\S* \|\| printf \S*gitdir: %s/)
    expect(command).toContain(' add -A')
    expect(command).toContain(' commit --quiet')
    expect(command).toContain('update-ref')
    expect(command).toContain('refs/dsh/original')
  })

  it('restores the original commit without recreating a baseline from edited files', async () => {
    const exec = vi.fn(async (_request: { command: string }) => ({ exitCode: 0, stdout: commit, stderr: '', logs: '' }))

    await expect(restoreBaseline(sandboxWith(exec), paths)).resolves.toEqual({ ready: true, commit })

    const command = String(exec.mock.calls[0]?.[0]?.command)
    expect(command).toContain('refs/dsh/original^{commit}')
    expect(command).toContain('HEAD^{commit}')
    expect(command).toContain('update-ref')
    expect(command).toContain('$commit')
    expect(command).toContain('config core.worktree')
    // An agent that ran `git init` in /workspace keeps its repository; the
    // baseline pairs through --git-dir and only writes the pointer when free.
    expect(command).toMatch(/\{ test -d \S*\/workspace\/\.git\S* \|\| printf \S*gitdir: %s/)
    expect(command).not.toContain('git init')
    expect(command).not.toContain(' add -A')
    expect(command).not.toContain(' commit ')
  })

  it('fails closed when a recovered sandbox has no original baseline', async () => {
    const exec = vi.fn(async (_request: { command: string }) => ({ exitCode: 1, stdout: '', stderr: 'missing baseline', logs: '' }))

    await expect(restoreBaseline(sandboxWith(exec), paths)).resolves.toEqual({
      ready: false,
      reason: 'Could not restore the divergence baseline: missing baseline',
    })
  })
})
