import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { type EntryOptions, evaluate, isJsExpr } from '@deepseek-ai/cordis-plugin-loader'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The stock Web profile rows this package's shipped patch list rewrites. */
const profileEntries: EntryOptions[] = [
  { id: 'subprocess', name: '@deepseek-ai/dsh-subprocess-local' },
  { id: 'fs-sandbox', name: '@deepseek-ai/dsh-fs-sandbox' },
  { id: 'sandbox-policy', name: '@deepseek-ai/dsh-sandbox-policy' },
  { id: 'bash-sandbox', name: '@deepseek-ai/dsh-bash-sandbox' },
  { id: 'pwsh-sandbox', name: '@deepseek-ai/dsh-pwsh-sandbox' },
  { id: 'approval', name: '@deepseek-ai/dsh-user-approval' },
  { id: 'permission', name: '@deepseek-ai/dsh-permission-presets' },
  {
    id: 'session-persistence-jsonl',
    name: '@deepseek-ai/dsh-session-persistence-jsonl',
    config: { root: '/custom-sessions', compression: 'none', packChunks: false },
  },
  { id: 'storage-json', name: '@deepseek-ai/dsh-storage-json', config: { root: '/custom-storages' } },
]

/** Apply the shipped patch list to a stock profile the way the include does. */
async function patchProfile(): Promise<{ entries: EntryOptions[]; warnings: string[] }> {
  const patches = yaml.load(await readFile(resolve(root, 'cordis.patch.yml'), 'utf8'), {
    schema: entryListSchema,
  }) as PatchOptions[]
  const warnings: string[] = []
  const entries = applyEntryPatches(profileEntries, patches, (message, ...args) => {
    warnings.push([message, ...args].join(' '))
  })
  return { entries, warnings }
}

/** Resolve one row's disabled state the way `Entry` does at activation. */
function disabledWith(entry: EntryOptions | undefined, env: Record<string, string>): boolean {
  if (!entry) throw new Error('missing entry')
  if (!isJsExpr(entry.disabled)) return Boolean(entry.disabled)
  return Boolean(evaluate({ process: { env, platform: process.platform } }, entry.disabled.__jsExpr))
}

describe('installable bundle', () => {
  it('declares one package with three Loader entry points', async () => {
    const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as {
      name?: string
      dsh?: { bundle?: { patch?: string } }
      exports?: Record<string, unknown>
      files?: string[]
    }

    expect(manifest.name).toBe('@blaxel/dsh-sandbox')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.exports).toHaveProperty('./runtime')
    expect(manifest.exports).toHaveProperty('./filesystem')
    expect(manifest.exports).toHaveProperty('./subprocess')
    expect(manifest.exports).toHaveProperty('./web')
    expect(manifest.exports).toHaveProperty('./client')
    expect(manifest.files).toContain('dist')
    expect(manifest.files).toContain('cordis.patch.yml')
  })

  it('keeps Loader modules default-only', async () => {
    const modules = await Promise.all([
      import('../src/runtime.js'),
      import('../src/filesystem.js'),
      import('../src/subprocess.js'),
    ])

    for (const module of modules) expect(Object.keys(module)).toEqual(['default'])
  })

  it('routes local and Blaxel sessions through one host', async () => {
    const { entries, warnings } = await patchProfile()

    expect(warnings).toEqual([])
    expect(entries.find(entry => entry.id === 'subprocess')?.disabled).toBe(true)
    expect(entries.find(entry => entry.id === 'fs-sandbox')?.disabled).toBe(true)
    expect(entries.find(entry => entry.id === 'blaxel-sessions')?.name).toBe('@blaxel/dsh-sandbox/session-runtime')
    expect(entries.find(entry => entry.id === 'blaxel-subprocess-router')?.name).toBe('@blaxel/dsh-sandbox/subprocess-routing')
    expect(entries.find(entry => entry.id === 'blaxel-filesystem-router')?.name).toBe('@blaxel/dsh-sandbox/filesystem-routing')
    expect(entries.find(entry => entry.id === 'blaxel-client')?.name).toBe('@blaxel/dsh-sandbox')
    expect(entries.find(entry => entry.id === 'blaxel-web')?.name).toBe('@blaxel/dsh-sandbox/web')
    expect(entries.find(entry => entry.id === 'sandbox-policy')?.config).toEqual({
      mode: { __jsExpr: "process.env.DSH_PERMISSION_MODE ?? 'workspace-write'" },
      workspaceRoot: { __jsExpr: 'process.cwd()' },
    })
    expect(entries.find(entry => entry.id === 'session-persistence-jsonl')?.config).toEqual({
      root: '/custom-sessions',
      compression: 'none',
      packChunks: false,
    })
    expect(entries.find(entry => entry.id === 'storage-json')?.config).toEqual({ root: '/custom-storages' })
  })

  it('keeps every router active because selection happens per session', async () => {
    const { entries } = await patchProfile()
    const blaxelRows = entries.filter(entry => entry.name.startsWith('@blaxel/'))
    expect(blaxelRows.map(entry => entry.id)).toEqual([
      'blaxel-sessions',
      'blaxel-subprocess-router',
      'blaxel-filesystem-router',
      'blaxel-client',
      'blaxel-web',
    ])
    for (const entry of blaxelRows) expect(disabledWith(entry, {}), entry.id).toBe(false)
  })
})
