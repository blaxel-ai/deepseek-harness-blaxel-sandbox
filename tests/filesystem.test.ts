import { Context } from '@deepseek-ai/cordis'
import { FsTargetKey } from '@deepseek-ai/dsh-fs'
import { describe, expect, it, vi } from 'vitest'
import { BlaxelFileSystem } from '../src/filesystem/service.js'
import type { BlaxelRuntime, SandboxInstance } from '../src/runtime/service.js'

function filesystemWithStatError(stderr: string): { fs: BlaxelFileSystem; exec: ReturnType<typeof vi.fn> } {
  const exec = vi.fn(async ({ command }: { command: string }) => {
    // Emulate shell pipeline semantics: without pipefail, base64 masks stat's
    // exit status and returns an empty successful response.
    if (!command.includes('set -o pipefail')) return { exitCode: 0, stdout: '', stderr: '' }
    return { exitCode: 1, stdout: '', stderr }
  })
  const sandbox = { process: { exec } } as unknown as SandboxInstance
  const runtime = {
    cwd: '/workspace',
    runtimeRoot: '/workspace/.dsh-blaxel',
    getSandbox: async () => sandbox,
    toRemotePath: (path: string) => path,
  } as unknown as BlaxelRuntime
  const ctx = new Context()
  ctx.provide('blaxel', runtime)
  return { fs: new BlaxelFileSystem(ctx), exec }
}

describe('Blaxel filesystem provider', () => {
  it('returns undefined for a missing target instead of masking stat behind base64', async () => {
    const { fs, exec } = filesystemWithStatError("stat: cannot statx '/workspace/missing': No such file or directory")
    await expect(fs.stat({
      targetKey: FsTargetKey('/workspace/missing'),
      displayPath: '/workspace/missing',
    })).resolves.toBeUndefined()
    expect(exec).toHaveBeenCalledOnce()
    expect(exec.mock.calls[0]?.[0].command).toContain('set -o pipefail; LC_ALL=C stat')
  })

  it('maps stat permission failures instead of pretending the target is absent', async () => {
    const { fs } = filesystemWithStatError("stat: cannot statx '/workspace/private': Permission denied")
    await expect(fs.stat({
      targetKey: FsTargetKey('/workspace/private'),
      displayPath: '/workspace/private',
    })).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  })
})
