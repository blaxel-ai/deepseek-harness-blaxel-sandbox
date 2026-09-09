import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { stringify } from 'yaml'
import type { SandboxInstance } from '@blaxel/core'
import type { CloudSeed } from '../cloud-guest.js'
import { CLOUD_ROOT } from '../cloud-guest.js'
import { MAX_TRANSFER_BYTES, requireTransferSize } from './attachments.js'

const execFileAsync = promisify(execFile)
const packageRoot = fileURLToPath(new URL('../../', import.meta.url))
const PREVIEW = 'dsh-session'
const DSH_VERSION = '0.1.2-rc.1'

async function packageArchive(): Promise<Buffer> {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-cloud-package-'))
  try {
    const archive = join(temp, 'plugin.tgz')
    await mkdir(join(temp, 'package'))
    for (const name of ['package.json', 'dist', 'patches', 'cordis.patch.yml', 'cloud.patch.yml']) {
      await cp(join(packageRoot, name), join(temp, 'package', name), { recursive: true })
    }
    await execFileAsync('tar', ['-czf', archive, '-C', temp, 'package'], { maxBuffer: 1024 * 1024 })
    const bytes = await readFile(archive)
    if (bytes.length > 32 * 1024 * 1024) throw new Error('The cloud runtime package exceeds 32 MiB')
    return bytes
  } finally { await rm(temp, { recursive: true, force: true }) }
}

export async function bootCloudHost(sandbox: SandboxInstance, seed: Omit<CloudSeed, 'previewOrigin'>, settings: Record<string, unknown>, env: Record<string, string>): Promise<void> {
  requireTransferSize(seed)
  const preview = await sandbox.previews.createIfNotExists({ metadata: { name: PREVIEW }, spec: { port: 5173, public: false } })
  const origin = preview.spec?.url
  if (!origin?.startsWith('https://')) throw new Error('Blaxel did not provide a private session URL')
  const browserExpires = Date.now() + 24 * 60 * 60 * 1000
  const browserToken = await preview.tokens.create(new Date(browserExpires))
  if (!browserToken.value) throw new Error('Could not create the private cloud login')
  const attempt = randomUUID().slice(0, 8)
  const init = await sandbox.process.exec({ name: `dsh-host-directories-${attempt}`, command: `umask 077; mkdir -p ${CLOUD_ROOT}/runtime ${CLOUD_ROOT}/home/profiles/web; test -f ${CLOUD_ROOT}/seed.json && printf seeded`, waitForCompletion: true, timeout: 20 })
  if (init.exitCode !== 0 && init.exitCode !== 1) throw new Error('Could not prepare the cloud host directory')
  await sandbox.fs.writeBinary(`${CLOUD_ROOT}/plugin.tgz`, await packageArchive())
  if (init.exitCode === 1) await sandbox.fs.write(`${CLOUD_ROOT}/seed.json`, JSON.stringify({ ...seed, previewOrigin: origin }))
  await sandbox.fs.write(`${CLOUD_ROOT}/home/settings.yaml`, stringify(settings))
  await sandbox.fs.write(`${CLOUD_ROOT}/home/profiles/web/package.json`, JSON.stringify({ name: 'dsh-cloud-session', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }))
  await sandbox.fs.write(`${CLOUD_ROOT}/home/profiles/web/cordis.patch.yml`, (await readFile(join(packageRoot, 'cloud.patch.yml'), 'utf8'))
    .replaceAll('__DSH_PREVIEW_HOST__', new URL(origin).host)
    .replaceAll('__DSH_PLUGIN_ROOT__', `${CLOUD_ROOT}/runtime/node_modules/@blaxel/dsh-sandbox`))
  const install = await sandbox.process.exec({
    name: `dsh-host-install-${attempt}`,
    command: `npm install --prefix ${CLOUD_ROOT}/runtime --no-audit --no-fund --omit=dev @deepseek-ai/dsh@${DSH_VERSION} ${CLOUD_ROOT}/plugin.tgz && ln -sfn ${CLOUD_ROOT}/runtime/node_modules ${CLOUD_ROOT}/home/profiles/web/node_modules`,
    waitForCompletion: true, timeout: 300,
  })
  if (install.exitCode !== 0) throw new Error('The pinned DeepSeek Harness cloud runtime could not be installed; your local conversation is intact')
  await sandbox.process.exec({
    name: 'dsh-cloud-host',
    command: `node ${CLOUD_ROOT}/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open --port 5173`,
    workingDir: seed.session.meta.cwd ?? '/workspace',
    env: { ...env, DSH_HOME: `${CLOUD_ROOT}/home`, DSH_BLAXEL_PREVIEW_ORIGIN: origin, DSH_BLAXEL_BROWSER_TOKEN: browserToken.value, DSH_BLAXEL_BROWSER_EXPIRES: String(browserExpires), DSH_BLAXEL_SANDBOX_NAME: seed.sandboxName, DSH_BLAXEL_WORKSPACE_NAME: seed.workspace },
    timeout: 0, keepAlive: true, restartOnFailure: true, maxRestarts: 3,
  })
  const ready = await sandbox.process.exec({
    name: `dsh-host-ready-${attempt}`,
    command: `node -e 'const net=require("node:net");const end=Date.now()+60000;function probe(){const s=net.connect(5173,"127.0.0.1",()=>{s.destroy();process.exit(0)});s.on("error",()=>{s.destroy();if(Date.now()>end)process.exit(1);setTimeout(probe,500)})}probe()'`,
    waitForCompletion: true, timeout: 70,
  })
  if (ready.exitCode !== 0) throw new Error('The cloud host did not start. Retry cloud setup; your conversation and sandbox files were retained')
}

/** Private preview tokens are short-lived and stay out of persistent binding records. */
export async function cloudRequest(sandbox: SandboxInstance, controlToken: string, command: string): Promise<Record<string, unknown>> {
  const preview = await sandbox.previews.get(PREVIEW)
  const token = await preview.tokens.create(new Date(Date.now() + (command === 'open' ? 24 * 60 : 5) * 60 * 1000))
  if (!preview.spec?.url || !token.value) throw new Error('Could not authorize access to the cloud session')
  const url = new URL('/blaxel/api/cloud-control', preview.spec.url)
  url.searchParams.set('bl_preview_token', token.value)
  const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${controlToken}`, 'x-dsh-cloud-command': command === 'open' ? 'health' : command }, signal: AbortSignal.timeout(command === 'freeze' ? 360_000 : 60_000) })
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('The cloud session returned an empty response')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.length
      if (size > MAX_TRANSFER_BYTES) throw new Error('The cloud session response exceeds its transfer limit')
      chunks.push(part.value)
    }
  } finally { await reader.cancel().catch(() => undefined) }
  let payload: Record<string, unknown>
  try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> } catch { throw new Error('The cloud session returned an unreadable response') }
  if (!response.ok || payload.ok !== true) throw new Error(typeof payload.error === 'string' ? payload.error : 'The cloud session could not be reached')
  if (command === 'open') {
    // Mint fresh access on every open, including after the original login expires.
    const browserUrl = new URL('/', preview.spec.url)
    browserUrl.searchParams.set('bl_preview_token', token.value)
    payload.url = browserUrl.href
  }
  return payload
}

/** Listening is earlier than plugin readiness; only the read-only health probe is retried. */
export async function waitForCloudHost(sandbox: SandboxInstance, controlToken: string): Promise<void> {
  const deadline = Date.now() + 60_000
  while (true) {
    try { await cloudRequest(sandbox, controlToken, 'health'); return } catch (error) {
      const process = await sandbox.process.get('dsh-cloud-host')
      if (process.status !== 'running' || Date.now() >= deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
}
