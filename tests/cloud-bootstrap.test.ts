import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SandboxInstance } from '@blaxel/core'
import { CLOUD_ROOT } from '../src/cloud-guest.js'
import { bootCloudHost } from '../src/cloud/bootstrap.js'

type Step = { kind: 'write', path: string, content: string } | { kind: 'exec', name: string, command: string }

function fakeSandbox(steps: Step[]): SandboxInstance {
  const preview = { spec: { url: 'https://dsh-session.preview.example' }, tokens: { create: async () => ({ value: 'browser-token' }) } }
  return {
    previews: { createIfNotExists: async () => preview },
    fs: {
      write: async (path: string, content: string) => { steps.push({ kind: 'write', path, content }) },
      writeBinary: async (path: string) => { steps.push({ kind: 'write', path, content: '<binary>' }) },
    },
    process: {
      exec: async ({ name, command }: { name: string, command: string }) => {
        steps.push({ kind: 'exec', name, command })
        // The directory probe reports "not seeded yet"; every other step succeeds.
        return { exitCode: name.startsWith('dsh-host-directories-') ? 1 : 0 }
      },
    },
  } as unknown as SandboxInstance
}

describe('cloud host bootstrap', () => {
  it('installs the cloud runtime from the committed lockfile before adding the plugin', async () => {
    const steps: Step[] = []
    const seed = { sandboxName: 'sbx', workspace: 'ws', session: { meta: { cwd: '/workspace' } } }
    // Skip packing dist/: the check runs tests before the build.
    await bootCloudHost(fakeSandbox(steps), seed as never, {}, {}, async () => Buffer.from('plugin'))

    const manifest = await readFile(resolve('runtime/package.json'), 'utf8')
    const lockfile = await readFile(resolve('runtime/package-lock.json'), 'utf8')
    const writes = steps.filter(step => step.kind === 'write')
    expect(writes.find(step => step.path === `${CLOUD_ROOT}/runtime/package.json`)?.content).toBe(manifest)
    expect(writes.find(step => step.path === `${CLOUD_ROOT}/runtime/package-lock.json`)?.content).toBe(lockfile)

    const installIndex = steps.findIndex(step => step.kind === 'exec' && step.name.startsWith('dsh-host-install-'))
    const install = steps[installIndex] as Extract<Step, { kind: 'exec' }>
    for (const path of [`${CLOUD_ROOT}/runtime/package.json`, `${CLOUD_ROOT}/runtime/package-lock.json`]) {
      expect(steps.findIndex(step => step.kind === 'write' && step.path === path)).toBeLessThan(installIndex)
    }
    expect(install.command.startsWith(`cd ${CLOUD_ROOT}/runtime && npm ci `)).toBe(true)
    expect(install.command.indexOf('npm ci ')).toBeLessThan(install.command.indexOf(`npm install `))
    expect(install.command).toContain(`${CLOUD_ROOT}/plugin.tgz`)
    expect(install.command).not.toContain('@deepseek-ai/dsh@')
  })

  it('pins every overridden Cordis package to the version the lockfile resolves', async () => {
    const manifest = JSON.parse(await readFile(resolve('runtime/package.json'), 'utf8')) as { overrides: Record<string, string> }
    const lock = JSON.parse(await readFile(resolve('runtime/package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string }> }
    expect(Object.keys(manifest.overrides)).toContain('@deepseek-ai/cordis-plugin-loader')
    for (const [name, version] of Object.entries(manifest.overrides)) {
      expect(lock.packages[`node_modules/${name}`]?.version).toBe(version)
    }
  })
})
