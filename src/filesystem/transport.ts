/**
 * Parsing for the NUL-framed, base64-wrapped output the sandbox commands emit.
 * Every field is validated here, so the service never trusts a partial record.
 */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import { decodeBase64, decodeBase64Text, decodeUtf8, splitNulTerminated } from '../shared/transport.js'

const STAT_FIELD_COUNT = 6
const LISTING_FIELD_COUNT = 4
const STRICT = { requireContent: true, requireCanonical: true } as const
const LENIENT = { requireCanonical: true } as const

export const DANGLING_SENTINEL = '!dangling!'
/** BusyBox and GNU stat both support `-c`; `|` cannot occur in these metadata fields. */
export const STAT_FORMAT = '%F|%s|%f|%i|%y|%d'

export interface RemoteStat {
  type: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  mode: number
  inode: string
  mtime: string
  device: string
}

function remoteType(value: string): RemoteStat['type'] {
  if (value === 'regular file' || value === 'regular empty file') return 'file'
  if (value === 'directory') return 'directory'
  if (value === 'symbolic link') return 'symlink'
  return 'other'
}

export function parseStatFields(fields: string[]): RemoteStat {
  if (fields.length !== STAT_FIELD_COUNT) throw new Error('dsh-blaxel: stat transport returned a malformed field group')
  const [rawType, rawSize, rawMode, inode, mtime, device] = fields
  const size = Number(rawSize)
  const mode = Number.parseInt(rawMode ?? '', 16)
  if (rawType === undefined || !/^\d+$/.test(rawSize ?? '') || !Number.isSafeInteger(size) || size < 0) {
    throw new Error('dsh-blaxel: stat transport returned an invalid size')
  }
  if (!/^[0-9a-f]+$/.test(rawMode ?? '') || !Number.isSafeInteger(mode)) {
    throw new Error('dsh-blaxel: stat transport returned an invalid mode')
  }
  if (!/^\d+$/.test(inode ?? '') || mtime === undefined || mtime.length === 0 || !/^\d+$/.test(device ?? '')) {
    throw new Error('dsh-blaxel: stat transport returned invalid identity facts')
  }
  return { type: remoteType(rawType), size, mode, inode, mtime, device }
}

export function parseStatTransport(encoded: string): RemoteStat {
  const text = decodeBase64Text(encoded, 'stat', STRICT)
  if (!text.endsWith('\n') || text.slice(0, -1).includes('\n')) {
    throw new Error('dsh-blaxel: stat transport returned invalid framing')
  }
  return parseStatFields(text.slice(0, -1).split('|'))
}

/** Decodes a bounded read plus its remote byte count, detecting SDK truncation. */
export function parseBoundedReadTransport(stdout: string): Buffer {
  const lines = stdout.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.length !== 2) throw new Error('dsh-blaxel: bounded read transport returned invalid framing')
  const [encoded, rawBytes] = lines
  if (!/^\d+$/.test(rawBytes ?? '')) throw new Error('dsh-blaxel: bounded read transport returned an invalid byte count')
  const bytes = decodeBase64(encoded ?? '', 'bounded read', LENIENT)
  if (bytes.byteLength !== Number(rawBytes)) {
    throw new Error('dsh-blaxel: bounded read transport returned partial content')
  }
  return bytes
}

export function decodeCanonicalPath(encoded: string): string {
  const framed = decodeBase64(encoded, 'canonical path', STRICT)
  if (framed.length < 2 || framed.at(-1) !== 0 || framed.subarray(0, -1).includes(0)) {
    throw new Error('dsh-blaxel: canonical path transport returned invalid NUL framing')
  }
  const path = decodeUtf8(framed.subarray(0, -1), 'canonical path')
  if (!posix.isAbsolute(path)) throw new Error('dsh-blaxel: canonical path is not absolute')
  return path
}

export function versionFor(path: string, stat: RemoteStat): FsVersion {
  return FsVersion(`blaxel:${createHash('sha256').update(JSON.stringify([
    path,
    stat.type,
    stat.size,
    stat.mode,
    stat.inode,
    stat.mtime,
    stat.device,
  ])).digest('hex')}`)
}

export function infoType(type: RemoteStat['type']): FsInfo['type'] {
  return type === 'file' || type === 'directory' ? type : 'other'
}

/** Parses the NUL-framed direct-child listing produced inside the sandbox. */
export function parseListingTransport(encoded: string, target: FsTarget): FsDirEntry[] {
  const fields = splitNulTerminated(decodeBase64Text(encoded, 'listing', LENIENT), 'listing')
  if (fields.length % LISTING_FIELD_COUNT !== 0) throw new Error('dsh-blaxel: listing transport returned a partial record')
  const entries: FsDirEntry[] = []
  for (let index = 0; index < fields.length; index += LISTING_FIELD_COUNT) {
    const path = fields[index]
    const entryFields = fields[index + 1]?.split('|') ?? []
    const followedValue = fields[index + 2]
    const canonical = fields[index + 3]
    if (path === undefined || canonical === undefined || !posix.isAbsolute(path) || !posix.isAbsolute(canonical)) {
      throw new Error('dsh-blaxel: listing transport returned a non-absolute path')
    }
    parseStatFields(entryFields)
    const followed = followedValue === DANGLING_SENTINEL ? undefined : parseStatFields(followedValue?.split('|') ?? [])
    const name = posix.basename(path)
    entries.push({
      name,
      type: followed === undefined ? 'other' : infoType(followed.type),
      target: { targetKey: FsTargetKey(canonical), displayPath: posix.join(target.displayPath, name) },
      ...(followed === undefined ? {} : { version: versionFor(canonical, followed) }),
      ...(followed?.type === 'file' ? { size: followed.size } : {}),
    })
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name))
}
