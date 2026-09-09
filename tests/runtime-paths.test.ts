import { describe, expect, it } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mapWorkspacePath } from '../src/runtime/paths.js'
import { shellQuote } from '../src/shared/shell.js'

describe('runtime paths', () => {
  it('maps a symlinked worktree root, including files that do not exist yet', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-path-alias-'))
    const alias = `${root}-alias`
    try {
      symlinkSync(root, alias)
      expect(mapWorkspacePath(realpathSync(root), '/workspace', join(alias, 'new', 'file.ts'))).toBe('/workspace/new/file.ts')
      expect(mapWorkspacePath(realpathSync(root), '/workspace', alias)).toBe('/workspace')
      expect(mapWorkspacePath(realpathSync(root), '/workspace', `${alias}-other/file.ts`)).toBe(`${alias}-other/file.ts`)
    } finally {
      rmSync(alias, { force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('quotes POSIX arguments without interpolation', () => {
    expect(shellQuote("a'b; $(touch /tmp/nope)\n")).toBe("'a'\"'\"'b; $(touch /tmp/nope)\n'")
  })

  it('maps source-worktree paths into the remote workspace only', () => {
    expect(mapWorkspacePath('/Users/test/repo', '/workspace', '/Users/test/repo')).toBe('/workspace')
    expect(mapWorkspacePath('/Users/test/repo', '/workspace', '/Users/test/repo/packages/app')).toBe('/workspace/packages/app')
    expect(mapWorkspacePath('/Users/test/repo', '/workspace', '/Users/test/other')).toBe('/Users/test/other')
    expect(mapWorkspacePath('/Users/test/repo', '/workspace', 'relative/file.ts')).toBe('relative/file.ts')
  })
})
