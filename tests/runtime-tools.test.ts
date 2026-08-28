import { describe, expect, it, vi } from 'vitest'
import type { SandboxInstance } from '@blaxel/core'
import { readSandboxEnvironment } from '../src/runtime/environment.js'
import { runtimeToolPreparationCommand } from '../src/runtime/workspace.js'

describe('sandbox runtime tool preparation', () => {
  it('installs lean-image omissions through a native package manager and verifies the DSH toolchain', () => {
    const command = runtimeToolPreparationCommand()
    expect(command).toContain('apt-get install -y -qq ripgrep procps')
    expect(command).toContain('apk add --no-cache ripgrep procps')
    expect(command).toContain('dnf install -y -q ripgrep procps-ng')
    expect(command).toContain('for tool in bash base64 env git mkfifo ps rg setsid tar')
    expect(command).toContain('command -v "$tool"')
  })

  it('runs the environment pipeline under Bash instead of the image default shell', async () => {
    const exec = vi.fn(async () => ({
      exitCode: 0,
      stdout: Buffer.from('HOME=/root\0').toString('base64'),
      stderr: '',
      logs: '',
    }))
    const sandbox = { process: { exec } } as unknown as SandboxInstance

    const environment = await readSandboxEnvironment(sandbox, '/workspace')

    expect(exec).toHaveBeenCalledWith(expect.objectContaining({
      command: expect.stringContaining("bash -o pipefail -c 'env -0 | base64 -w0'"),
      workingDir: '/workspace',
    }))
    expect(environment.get('HOME')).toBe('/root')
  })
})
