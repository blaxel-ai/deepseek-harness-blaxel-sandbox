import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// runtime/package-lock.json is installed verbatim with `npm ci` in every cloud
// session, so a regeneration for a new DSH version must not pull these packages
// back below their advisory floors.
const floors: Record<string, [string, string]> = {
  'proxy-addr': ['2.0.8', 'GHSA-jqcg-44mw-7w3h'],
  '@modelcontextprotocol/sdk': ['1.31.0', 'GHSA-6qxp-vccf-f47h'],
  compression: ['1.8.2', 'GHSA-vc2v-76pw-4v95'],
  sharp: ['0.35.5', 'GHSA-wq5f-xc86-pv6w'],
}

const atLeast = (version: string, floor: string) => {
  const a = version.split('.').map(Number)
  const b = floor.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return true
}

describe('runtime lockfile advisory floors', () => {
  it('resolves every copy of each patched package at or above its floor', async () => {
    const lock = JSON.parse(await readFile(resolve('runtime/package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string }> }
    for (const [name, [floor, advisory]] of Object.entries(floors)) {
      const copies = Object.entries(lock.packages).filter(([path]) => path.endsWith(`node_modules/${name}`))
      expect(copies.length, name).toBeGreaterThan(0)
      for (const [path, entry] of copies) {
        expect(atLeast(entry.version ?? '0.0.0', floor), `${path}@${entry.version} < ${floor} (${advisory})`).toBe(true)
      }
    }
  })
})
