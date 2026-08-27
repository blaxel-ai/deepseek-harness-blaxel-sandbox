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
      expect(Buffer.from(await ctx.fs.readBytes(target, undefined, 64)).toString()).toBe('written-by-fs\n')
      await expect(ctx.fs.readBytes(target, undefined, 4)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })

      const crlf = await ctx.fs.resolve('crlf.txt')
      await ctx.fs.writeText(crlf, 'one\r\ntwo\r\n', { kind: 'createIfAbsent' })
      const observed = await ctx.fs.stat(crlf)
      if (observed === undefined) throw new Error('live filesystem stat returned no result')
      await ctx.fs.editText(crlf, { oldString: 'one\n', newString: 'first\n', replaceAll: false }, { version: observed.version })
      expect(await ctx.fs.readText(crlf)).toBe('first\r\ntwo\r\n')
      await expect(ctx.fs.writeText(crlf, 'must-not-win', { kind: 'createIfAbsent' }))
        .rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })

      const linked = await ctx.blaxel.getSandbox().then(sandbox => sandbox.process.exec({
        command: 'ln -s probe.txt alias.txt',
        workingDir: ctx.blaxel.cwd,
        waitForCompletion: true,
      }))
      expect(linked.exitCode).toBe(0)
      const alias = await ctx.fs.resolve('alias.txt')
      expect(alias.targetKey).toBe(target.targetKey)
      expect((await ctx.fs.listDir(await ctx.fs.resolve('.'))).map(entry => entry.name)).toContain('alias.txt')

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
