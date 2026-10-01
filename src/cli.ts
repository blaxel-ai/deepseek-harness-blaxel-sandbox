#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const version = '0.1.2-rc.1'
const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const patch = join(packageRoot, 'patches', `@deepseek-ai__dsh-session@${version}.patch`)
// The runtime installs from a committed lockfile. Without it, npm resolves DSH's
// ^1.0.3 range to cordis-plugin-loader 1.0.4+, which this DSH build cannot boot with.
const runtimeManifest = join(packageRoot, 'runtime', 'package.json')
const runtimeLockfile = join(packageRoot, 'runtime', 'package-lock.json')

/** Profile dependencies can shadow the launcher's cached native session package. */
export async function prepareProfileImports(profileRoot: string): Promise<void> {
  const require = createRequire(join(profileRoot, 'package.json'))
  const roots = new Set<string>()
  for (const anchor of ['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-agent']) {
    let manifest: string
    try { manifest = require.resolve(`${anchor}/package.json`) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') continue; throw error }
    const sessionManifest = createRequire(manifest).resolve('@deepseek-ai/dsh-session/package.json')
    roots.add(dirname(await realpath(sessionManifest)))
  }
  for (const root of roots) {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version?: string }
    if (manifest.version !== version) throw new Error(`Cloud history import requires @deepseek-ai/dsh-session ${version}`)
    try { await exec('git', ['apply', '--reverse', '--check', patch], { cwd: root }); continue }
    catch { /* Apply only when the exact supported source accepts the patch. */ }
    try {
      await exec('git', ['apply', '--check', patch], { cwd: root })
      await exec('git', ['apply', patch], { cwd: root })
    } catch (error) {
      // Another launcher may have finished the same patch after our check.
      try { await exec('git', ['apply', '--reverse', '--check', patch], { cwd: root }) }
      catch { throw error }
    }
  }
}

/** Keep the required native import extension isolated from the user's installed DSH. */
export async function prepareRuntime(cacheRoot = process.env.DSH_BLAXEL_RUNTIME_CACHE ?? join(homedir(), '.cache', 'blaxel', 'dsh')): Promise<string> {
  const [patchSource, manifestSource, lockfileSource] = await Promise.all([readFile(patch), readFile(runtimeManifest), readFile(runtimeLockfile)])
  // Key the cache on the exact install inputs, so a runtime built from a different
  // lockfile (including earlier unlocked installs) is never reused.
  const hash = createHash('sha256').update(patchSource).update(manifestSource).update(lockfileSource).digest('hex').slice(0, 16)
  const directory = join(cacheRoot, `${version}-${hash}`)
  const entry = join(directory, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
  try { await readFile(join(directory, 'ready')); return entry }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 })
  const temporary = await mkdtemp(join(cacheRoot, 'install-'))
  try {
    await writeFile(join(temporary, 'package.json'), manifestSource)
    await writeFile(join(temporary, 'package-lock.json'), lockfileSource)
    process.stderr.write('Preparing the pinned DeepSeek cloud-session runtime (first launch only)...\n')
    await exec('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: temporary, maxBuffer: 4 * 1024 * 1024, timeout: 300_000 })
    const require = createRequire(join(temporary, 'node_modules/@deepseek-ai/dsh/package.json'))
    const sessionRoot = dirname(require.resolve('@deepseek-ai/dsh-session/package.json'))
    await exec('git', ['apply', '--check', patch], { cwd: sessionRoot })
    await exec('git', ['apply', patch], { cwd: sessionRoot })
    await writeFile(join(temporary, 'ready'), hash, { mode: 0o600 })
    try { await rename(temporary, directory) }
    catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; await readFile(join(directory, 'ready')) }
    return entry
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

const packageName = '@blaxel/dsh-sandbox'

/**
 * Pin `plugin ... add @blaxel/dsh-sandbox[@latest]` to this launcher's own version.
 * The profile plugin then matches the runtime the launcher prepared, and pnpm's
 * minimumReleaseAge cannot quietly install an older plugin during a release's first day.
 */
export function pinPluginSpec(args: readonly string[], launcherVersion: string): string[] {
  if (args[0] !== 'plugin' || !args.includes('add')) return [...args]
  return args.map(argument => argument === packageName || argument === `${packageName}@latest` ? `${packageName}@${launcherVersion}` : argument)
}

async function main(): Promise<void> {
  const entry = await prepareRuntime()
  const { version: launcherVersion } = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as { version: string }
  const args = pinPluginSpec(process.argv.slice(2), launcherVersion)
  if (args[0] !== 'plugin') {
    const index = args.findIndex(argument => argument === '--profile' || argument.startsWith('--profile='))
    const profile = args[0] === 'web' || index < 0 ? 'web' : args[index] === '--profile' ? args[index + 1] : args[index]!.slice('--profile='.length)
    if (profile) await prepareProfileImports(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', profile))
  }
  const child = spawn(process.execPath, [entry, ...args], { stdio: 'inherit', env: process.env })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal))
  child.on('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
  child.on('exit', code => { process.exitCode = code ?? 1 })
}
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === await realpath(process.argv[1])) {
  void main().catch(error => { process.stderr.write(`Could not start the cloud-session runtime: ${error instanceof Error ? error.message : 'installation failed'}\n`); process.exitCode = 1 })
}
