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

/** Keep the required native import extension isolated from the user's installed DSH. */
export async function prepareRuntime(cacheRoot = process.env.DSH_BLAXEL_RUNTIME_CACHE ?? join(homedir(), '.cache', 'blaxel', 'dsh')): Promise<string> {
  const hash = createHash('sha256').update(await readFile(patch)).digest('hex').slice(0, 16)
  const directory = join(cacheRoot, `${version}-${hash}`)
  const entry = join(directory, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
  try { await readFile(join(directory, 'ready')); return entry }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 })
  const temporary = await mkdtemp(join(cacheRoot, 'install-'))
  try {
    await writeFile(join(temporary, 'package.json'), JSON.stringify({ name: 'blaxel-cloud-session-host', private: true, dependencies: { '@deepseek-ai/dsh': version } }))
    process.stderr.write('Preparing the pinned DeepSeek cloud-session runtime (first launch only)...\n')
    await exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: temporary, maxBuffer: 4 * 1024 * 1024, timeout: 300_000 })
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

async function main(): Promise<void> {
  const entry = await prepareRuntime()
  const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal))
  child.on('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
  child.on('exit', code => { process.exitCode = code ?? 1 })
}
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === await realpath(process.argv[1])) {
  void main().catch(error => { process.stderr.write(`Could not start the cloud-session runtime: ${error instanceof Error ? error.message : 'installation failed'}\n`); process.exitCode = 1 })
}
