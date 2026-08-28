import { Buffer } from 'node:buffer'
import { FsTargetKey } from '@deepseek-ai/dsh-fs'
import { describe, expect, it } from 'vitest'
import { detectsCrlf, literalEdit, restoreLineEndings } from '../src/filesystem/edit.js'
import {
  decodeCanonicalPath,
  parseBoundedReadTransport,
  parseListingTransport,
  parseStatFields,
  parseStatTransport,
} from '../src/filesystem/transport.js'

describe('filesystem transport and edits', () => {
  const statFields = (type: string, size: number, mode: string, inode: number): string[] =>
    [type, String(size), mode, String(inode), '2026-08-20 12:34:56.000000000 +0000', '2049']

  it('validates canonical paths and empty regular-file metadata', () => {
    expect(decodeCanonicalPath(Buffer.from('/workspace/real\0').toString('base64'))).toBe('/workspace/real')
    expect(() => decodeCanonicalPath(Buffer.from('relative\0').toString('base64'))).toThrow('not absolute')
    expect(() => decodeCanonicalPath(Buffer.from('/workspace/real').toString('base64'))).toThrow('NUL framing')
    expect(() => decodeCanonicalPath('not base64')).toThrow('invalid base64')
    expect(parseStatFields(statFields('regular empty file', 0, '81a4', 42))).toMatchObject({
      type: 'file',
      size: 0,
      mode: 0x81a4,
      inode: '42',
    })
    expect(() => parseStatFields(statFields('regular file', -1, '81a4', 42))).toThrow('invalid size')
    expect(() => parseStatFields(statFields('regular file', 1, 'nope', 42))).toThrow('invalid mode')
    const stat = `${statFields('regular file', 7, '81a4', 11).join('|')}\n`
    expect(parseStatTransport(Buffer.from(stat).toString('base64'))).toMatchObject({ type: 'file', size: 7 })
  })

  it('detects partial bounded-read transports', () => {
    const bytes = Buffer.from('bounded bytes')
    expect(parseBoundedReadTransport(`${bytes.toString('base64')}\n${String(bytes.length)}\n`)).toEqual(bytes)
    expect(parseBoundedReadTransport('\n0\n')).toEqual(Buffer.alloc(0))
    expect(() => parseBoundedReadTransport(`${bytes.toString('base64')}\n999\n`)).toThrow('partial content')
    expect(() => parseBoundedReadTransport(bytes.toString('base64'))).toThrow('invalid framing')
  })

  it('parses stable listings with followed and dangling symlinks', () => {
    const fields = [
      '/workspace/z-link',
      statFields('symbolic link', 3, 'a1ff', 10).join('|'),
      statFields('regular file', 7, '81a4', 11).join('|'),
      '/workspace/file.txt',
      '/workspace/a-dangling',
      statFields('symbolic link', 7, 'a1ff', 12).join('|'),
      '!dangling!',
      '/workspace/missing.txt',
    ]
    const encoded = Buffer.from(`${fields.join('\0')}\0`).toString('base64')
    const entries = parseListingTransport(encoded, {
      targetKey: FsTargetKey('/workspace'),
      displayPath: '/shown',
    })
    expect(entries.map(entry => ({ name: entry.name, type: entry.type, path: entry.target.targetKey }))).toEqual([
      { name: 'a-dangling', type: 'other', path: '/workspace/missing.txt' },
      { name: 'z-link', type: 'file', path: '/workspace/file.txt' },
    ])
    expect(entries[1]?.size).toBe(7)
    expect(parseListingTransport('', { targetKey: FsTargetKey('/workspace'), displayPath: '/shown' })).toEqual([])
    expect(() => parseListingTransport(Buffer.from(fields.join('\0')).toString('base64'), {
      targetKey: FsTargetKey('/workspace'),
      displayPath: '/shown',
    })).toThrow('not NUL-terminated')
  })

  it('edits LF-normalized text and restores a CRLF-dominant file', () => {
    const raw = 'one\r\ntwo\r\n'
    expect(detectsCrlf(raw)).toBe(true)
    const after = literalEdit('one\ntwo\n', { oldString: 'one\r\n', newString: 'first\r\n', replaceAll: false }, '/file')
    expect(after).toBe('first\ntwo\n')
    expect(restoreLineEndings(after, true)).toBe('first\r\ntwo\r\n')
    expect(() => literalEdit('x x', { oldString: 'x', newString: 'y', replaceAll: false }, '/file'))
      .toThrow(expect.objectContaining({ code: 'FS_AMBIGUOUS_EDIT' }))
  })
})
