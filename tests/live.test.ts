import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { BlaxelFileSystem, BlaxelRuntime, BlaxelSubprocessRuntime } from '../src/index.js'

const enabled = process.env.DSH_BLAXEL_LIVE === '1'

describe.skipIf(!enabled)('Blaxel live DSH seams', () => {
  it('runs filesystem, subprocess, and terminal operations in one sandbox', async () => {
    const ctx = new Context()
    const owner = await ctx.plugin(BlaxelRuntime, {
      name: `dsh-live-${Date.now().toString(36)}`,
      image: 'blaxel/ts-app:latest',
      cwd: '/workspace',
      memory: 4096,
      region: process.env.BL_REGION ?? 'us-pdx-1',
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

      const unusual = await ctx.fs.resolve('nested/日本語 file\nwith newline.txt')
      await ctx.fs.writeText(unusual, 'first\n', { kind: 'createIfAbsent' })
      const old = await ctx.fs.stat(unusual)
      await ctx.fs.writeText(unusual, 'changed externally\n')
      await expect(ctx.fs.editText(unusual, { oldString: 'first', newString: 'stale', replaceAll: false }, { version: old!.version }))
        .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
      expect(await ctx.fs.readText(unusual)).toBe('changed externally\n')
      expect((await ctx.fs.listDir(await ctx.fs.resolve('nested'))).map(entry => entry.name)).toContain('日本語 file\nwith newline.txt')

      const raced = await ctx.fs.resolve('simultaneous-create.txt')
      const writes = await Promise.allSettled([
        ctx.fs.writeText(raced, 'first writer', { kind: 'createIfAbsent' }),
        ctx.fs.writeText(raced, 'second writer', { kind: 'createIfAbsent' }),
      ])
      expect(writes.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
      expect(await ctx.fs.readText(raced)).toBe('first writer')
      const aborted = new AbortController()
      aborted.abort()
      await expect(ctx.fs.writeText(raced, 'must not write', undefined, aborted.signal)).rejects.toThrow()
      expect(await ctx.fs.readText(raced)).toBe('first writer')
      await expect(ctx.fs.readText(await ctx.fs.resolve('absent.txt'))).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
      await expect(ctx.fs.readText(await ctx.fs.resolve('nested'))).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })

      const failedCommand = ctx.subprocess.spawn({
        argv: ['/bin/bash', '-lc', 'printf "command not found" >&2; exit 37'], cwd: ctx.blaxel.cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 64 }, stderr: { maxBytes: 64 } }, graceMs: 500,
      })
      await expect(failedCommand.done).resolves.toMatchObject({ exitCode: 37 })
      expect(ctx.blaxel.phase).toBe('ready')
      const missingDirectory = ctx.subprocess.spawn({
        argv: ['/bin/bash', '-lc', 'printf unexpected > /workspace/wrong-directory.txt'], cwd: '/workspace/does-not-exist',
        stdio: { stdin: 'ignore', stdout: { maxBytes: 64 }, stderr: { maxBytes: 1024 } }, graceMs: 500,
      })
      await expect(missingDirectory.done).rejects.toThrow("folder '/workspace/does-not-exist' does not exist")
      expect(ctx.blaxel.phase).toBe('ready')
      expect(await ctx.fs.stat(await ctx.fs.resolve('wrong-directory.txt'))).toBeUndefined()
      const verbose = ctx.subprocess.spawn({
        argv: ['/bin/bash', '-lc', 'head -c 8192 /dev/zero | tr "\\0" x'], cwd: ctx.blaxel.cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 64 }, stderr: { maxBytes: 64 } }, graceMs: 500,
      })
      await verbose.done
      expect(verbose.collected.stdout?.readFrom(0)).toMatchObject({ text: 'x'.repeat(64), nextOffset: 8192, lossy: true })

      const slow = ctx.subprocess.spawn({
        argv: ['/bin/bash', '-lc', 'sleep 2; printf orphaned > late-child.txt'], cwd: ctx.blaxel.cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 64 }, stderr: { maxBytes: 64 } }, graceMs: 500,
      })
      await new Promise(resolve => setTimeout(resolve, 300))
      slow.terminate()
      await slow.done
      await new Promise(resolve => setTimeout(resolve, 2200))
      expect(await ctx.fs.stat(await ctx.fs.resolve('late-child.txt'))).toBeUndefined()

      const background = ctx.subprocess.spawn({
        argv: ['/bin/bash', '-lc', '(sleep 2; printf orphaned > background-child.txt) & exit 0'], cwd: ctx.blaxel.cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 64 }, stderr: { maxBytes: 64 } }, graceMs: 500,
      })
      await background.done
      await new Promise(resolve => setTimeout(resolve, 2200))
      expect(await ctx.fs.stat(await ctx.fs.resolve('background-child.txt'))).toBeUndefined()
    } finally {
      await subprocess.dispose()
      await fs.dispose()
      await owner.dispose()
    }
  }, 180_000)
})
