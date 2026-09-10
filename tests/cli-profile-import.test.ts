import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { prepareProfileImports } from '../src/cli.js'

const require = createRequire(import.meta.url)

describe('profile session import support', () => {
  it('patches a profile-local native session and remains safe to rerun', async () => {
    const root = await mkdtemp(resolve('node_modules/.dsh-profile-import-test-'))
    const target = join(root, 'node_modules/@deepseek-ai/dsh-session')
    const patch = resolve('patches/@deepseek-ai__dsh-session@0.1.2-rc.1.patch')
    try {
      await mkdir(dirname(target), { recursive: true })
      const source = require.resolve('@deepseek-ai/dsh-session/package.json')
      await cp(dirname(source), target, { recursive: true })
      const dependencies = (JSON.parse(await readFile(source, 'utf8')) as { dependencies: Record<string, string> }).dependencies
      for (const name of Object.keys(dependencies)) {
        const destination = join(root, 'node_modules', name)
        await mkdir(dirname(destination), { recursive: true })
        await symlink(dirname(createRequire(source).resolve(`${name}/package.json`)), destination, 'dir')
      }
      await writeFile(join(root, 'package.json'), '{"private":true}')
      execFileSync('git', ['apply', '--reverse', patch], { cwd: target })
      await Promise.all(Array.from({ length: 8 }, () => prepareProfileImports(root)))
      await prepareProfileImports(root)
      const native = await import(pathToFileURL(join(target, 'lib/index.js')).href) as { Session: { prototype: { appendImported?: unknown } } }
      expect(typeof native.Session.prototype.appendImported).toBe('function')
      execFileSync('git', ['apply', '--reverse', '--check', patch], { cwd: target })
      const home = join(root, 'home')
      await mkdir(join(home, 'profiles'), { recursive: true })
      await symlink(root, join(home, 'profiles/team'), 'dir')
      const hash = createHash('sha256').update(await readFile(patch)).digest('hex').slice(0, 16)
      const cache = join(root, 'cache')
      const runtime = join(cache, `0.1.2-rc.1-${hash}`)
      const entry = join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
      await mkdir(dirname(entry), { recursive: true })
      await writeFile(join(dirname(dirname(entry)), 'package.json'), '{"type":"module"}')
      await writeFile(entry, `import { Session } from ${JSON.stringify(pathToFileURL(join(target, 'lib/index.js')).href)}; console.log(typeof Session.prototype.appendImported)`)
      await writeFile(join(runtime, 'ready'), hash)
      for (const args of [['--profile', 'team'], ['--profile=team']]) {
        execFileSync('git', ['apply', '--reverse', patch], { cwd: target })
        const output = execFileSync(process.execPath, ['--experimental-strip-types', resolve('src/cli.ts'), ...args], {
          env: { ...process.env, DSH_HOME: home, DSH_BLAXEL_RUNTIME_CACHE: cache }, encoding: 'utf8',
        })
        expect(output.trim()).toBe('function')
      }
      await rm(join(home, 'profiles/team'))
      await symlink(root, join(home, 'profiles/web'), 'dir')
      const unrelated = join(home, 'profiles/team/node_modules/@deepseek-ai/dsh-session')
      await mkdir(unrelated, { recursive: true })
      await writeFile(join(unrelated, 'package.json'), '{"name":"@deepseek-ai/dsh-session","version":"unsupported"}')
      execFileSync('git', ['apply', '--reverse', patch], { cwd: target })
      const output = execFileSync(process.execPath, ['--experimental-strip-types', resolve('src/cli.ts'), 'web', '--profile=team'], {
        env: { ...process.env, DSH_HOME: home, DSH_BLAXEL_RUNTIME_CACHE: cache }, encoding: 'utf8',
      })
      expect(output.trim()).toBe('function')
      expect(JSON.parse(await readFile(join(unrelated, 'package.json'), 'utf8')).version).toBe('unsupported')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
