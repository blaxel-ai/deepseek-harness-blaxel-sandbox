import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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

  it('keeps local execution by default and activates one shared Blaxel world on demand', async () => {
    const patches = yaml.load(await readFile(resolve(root, 'cordis.patch.yml'), 'utf8'), {
      schema: entryListSchema,
    }) as PatchOptions[]
    const warnings: string[] = []
    const entries = applyEntryPatches([
      { id: 'subprocess', name: '@deepseek-ai/dsh-subprocess-local' },
      { id: 'fs-sandbox', name: '@deepseek-ai/dsh-fs-sandbox' },
      { id: 'sandbox-policy', name: '@deepseek-ai/dsh-sandbox-policy' },
      { id: 'bash-sandbox', name: '@deepseek-ai/dsh-bash-sandbox' },
      { id: 'pwsh-sandbox', name: '@deepseek-ai/dsh-pwsh-sandbox' },
      { id: 'approval', name: '@deepseek-ai/dsh-user-approval' },
      { id: 'permission', name: '@deepseek-ai/dsh-permission-presets' },
      { id: 'session-persistence-jsonl', name: '@deepseek-ai/dsh-session-persistence-jsonl' },
      { id: 'storage-json', name: '@deepseek-ai/dsh-storage-json' },
    ], patches, (message, ...args) => { warnings.push([message, ...args].join(' ')) })

    expect(warnings).toEqual([])
    expect(entries.find(entry => entry.id === 'subprocess')?.disabled).toEqual({ __jsExpr: "process.env.DSH_BLAXEL_ACTIVE === '1'" })
    expect(entries.find(entry => entry.id === 'fs-sandbox')?.disabled).toEqual({ __jsExpr: "process.env.DSH_BLAXEL_ACTIVE === '1'" })
    expect(entries.find(entry => entry.id === 'bash-sandbox')?.disabled).toEqual({ __jsExpr: "process.env.DSH_BLAXEL_ACTIVE === '1' ? false : process.platform === 'win32'" })
    expect(entries.find(entry => entry.id === 'pwsh-sandbox')?.disabled).toEqual({ __jsExpr: "process.env.DSH_BLAXEL_ACTIVE === '1' || process.platform !== 'win32'" })
    expect(entries.find(entry => entry.id === 'blaxel-runtime')?.disabled).toEqual({ __jsExpr: "process.env.DSH_BLAXEL_ACTIVE !== '1'" })
    expect(entries.find(entry => entry.id === 'blaxel-subprocess')?.disabled).toEqual({ __jsExpr: "process.env.DSH_BLAXEL_ACTIVE !== '1'" })
    expect(entries.find(entry => entry.id === 'blaxel-filesystem')?.disabled).toEqual({ __jsExpr: "process.env.DSH_BLAXEL_ACTIVE !== '1'" })
    expect(entries.find(entry => entry.id === 'blaxel-client')?.name).toBe('@blaxel/dsh-sandbox')
    expect(entries.find(entry => entry.id === 'blaxel-web')?.name).toBe('@blaxel/dsh-sandbox/web')
    expect(entries.find(entry => entry.id === 'sandbox-policy')?.config).toEqual({
      mode: { __jsExpr: "process.env.DSH_BLAXEL_ACTIVE === '1' ? 'danger-full-access' : (process.env.DSH_PERMISSION_MODE ?? 'workspace-write')" },
      workspaceRoot: { __jsExpr: "process.env.DSH_BLAXEL_ACTIVE === '1' ? (process.env.DSH_BLAXEL_WORKSPACE_ROOT || '/workspace') : process.cwd()" },
    })
    expect(entries.find(entry => entry.id === 'session-persistence-jsonl')?.config).toEqual({
      root: { __jsExpr: "process.env.DSH_BLAXEL_SESSION_ROOT || dshHomePath('sessions')" },
    })
    expect(entries.find(entry => entry.id === 'storage-json')?.config).toEqual({
      root: { __jsExpr: "process.env.DSH_BLAXEL_STORAGE_ROOT || dshHomePath('storages')" },
    })
  })
})
