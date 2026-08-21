import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { BlaxelFileSystem, BlaxelRuntime, BlaxelSubprocessRuntime } from '../src/index.js'

const enabled = process.env.DSH_BLAXEL_LIVE === '1'

describe.skipIf(!enabled)('Blaxel live DSH seams', () => {
  it('runs filesystem, subprocess, and terminal operations in one sandbox', async () => {
    const ctx = new Context()
    const owner = await ctx.plugin(BlaxelRuntime, {
      name: `dsh-live-${Date.now().toString(36)}`,
      image: 'blaxel/node:latest',
      cwd: '/workspace',
      memory: 4096,
      region: 'us-pdx-1',
      ttl: '10m',
    })
    const fs = await ctx.plugin(BlaxelFileSystem)
    const subprocess = await ctx.plugin(BlaxelSubprocessRuntime)
    try {
      const target = await ctx.fs.resolve('probe.txt')
      await ctx.fs.writeText(target, 'written-by-fs\n')
      expect(await ctx.fs.readText(target)).toBe('written-by-fs\n')
      const process = ctx.subprocess.spawn({
        argv: ['/bin/bash', '-lc', 'printf written-by-bash'], cwd: ctx.blaxel.cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 500,
      })
      await expect(process.done).resolves.toMatchObject({ exitCode: 0, signal: null })
      expect(process.collected.stdout?.readFrom(0).text).toBe('written-by-bash')
      const stdinProcess = ctx.subprocess.spawn({
        argv: ['/bin/bash', '-s'], cwd: ctx.blaxel.cwd,
        stdio: { stdin: { data: 'printf stdin-ok' }, stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 500,
      })
      await expect(stdinProcess.done).resolves.toMatchObject({ exitCode: 0, signal: null })
      expect(stdinProcess.collected.stdout?.readFrom(0).text).toBe('stdin-ok')
      const terminal = await ctx.subprocess.spawnTerminal({
        argv: ['/bin/bash', '--noprofile', '--norc', '-i'], cwd: ctx.blaxel.cwd,
        rows: 24, cols: 80, graceMs: 500,
      })
      const chunks: Buffer[] = []
      terminal.output.on('data', chunk => chunks.push(Buffer.from(chunk)))
      await terminal.write("printf 'DSH_BLAXEL_TERMINAL_OK\\n'\r")
      await new Promise(resolve => setTimeout(resolve, 500))
      expect(Buffer.concat(chunks).toString()).toContain('DSH_BLAXEL_TERMINAL_OK')
      await terminal.terminate()
    } finally {
      await subprocess.dispose()
      await fs.dispose()
      await owner.dispose()
    }
  }, 120_000)
})
