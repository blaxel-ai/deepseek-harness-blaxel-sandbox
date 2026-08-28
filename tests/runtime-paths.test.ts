import { describe, expect, it } from 'vitest'
import { mapWorkspacePath } from '../src/runtime/paths.js'
import { shellQuote } from '../src/shared/shell.js'

describe('runtime paths', () => {
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
