import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { boundPatchText, parsePorcelainStatus, parseShortStat, summarizeReport } from '../src/web/divergence.js'

describe('workspace divergence', () => {
  it('parses NUL-framed porcelain status including renames and spaces', () => {
    const raw = ' M dir with space/f.txt\0R  new name.txt\0old.txt\0?? untracked.txt\0'
    expect(parsePorcelainStatus(raw)).toEqual({
      changed: 3,
      truncated: false,
      files: [
        { status: ' M', path: 'dir with space/f.txt' },
        { status: 'R ', path: 'new name.txt', from: 'old.txt' },
        { status: '??', path: 'untracked.txt' },
      ],
    })
  })

  it('counts every change while bounding the reported file list', () => {
    const raw = Array.from({ length: 5 }, (_unused, index) => ` M file-${String(index)}.ts\0`).join('')
    const result = parsePorcelainStatus(raw, 2)
    expect(result.changed).toBe(5)
    expect(result.truncated).toBe(true)
    expect(result.files.map(file => file.path)).toEqual(['file-0.ts', 'file-1.ts'])
  })

  it('reads shortstat counters and tolerates a missing one', () => {
    expect(parseShortStat(' 2 files changed, 3 insertions(+), 1 deletion(-)')).toEqual({ insertions: 3, deletions: 1 })
    expect(parseShortStat(' 1 file changed, 1 insertion(+)')).toEqual({ insertions: 1 })
    expect(parseShortStat(' 1 file changed, 2 deletions(-)')).toEqual({ deletions: 2 })
    expect(parseShortStat('')).toEqual({})
  })

  it('reads the report script output and trusts only whole records', () => {
    const listing = ' M src/a.ts\0A  src/new.ts\0'
    const stdout = [Buffer.from(listing, 'utf8').toString('base64'), String(listing.length), ' 2 files changed, 4 insertions(+), 1 deletion(-)'].join('\n')
    const summary = summarizeReport(stdout)
    expect(summary.changed).toBe(2)
    expect(summary.truncated).toBe(false)
    expect(summary).toMatchObject({ insertions: 4, deletions: 1 })
    expect(summary.files.map(file => file.path)).toStrictEqual(['src/a.ts', 'src/new.ts'])
  })

  it('reports a listing the sandbox cut short instead of counting it as complete', () => {
    const cut = ' M src/a.ts\0 M src/partial'
    const encoded = Buffer.from(cut, 'utf8').toString('base64')
    const stdout = [encoded, '4096', ''].join('\n')
    const summary = summarizeReport(stdout, 32)
    expect(summary.truncated).toBe(true)
    expect(summary.changed).toBe(1)
    expect(summary.files.map(file => file.path)).toStrictEqual(['src/a.ts'])
    expect(() => summarizeReport(encoded)).toThrow('partial divergence report')
    expect(() => summarizeReport([encoded, '1', ''].join('\n'))).toThrow('partial divergence report')
  })

  it('caps the patch on a line boundary and reports truncation', () => {
    const patch = 'diff --git a/a b/a\n+one\n+two\n'
    expect(boundPatchText(patch)).toEqual({ text: patch, bytes: patch.length, truncated: false })
    const bounded = boundPatchText(patch, 26)
    expect(bounded.truncated).toBe(true)
    expect(bounded.text).toBe('diff --git a/a b/a\n+one\n')
    expect(bounded.bytes).toBe(24)
  })
})
