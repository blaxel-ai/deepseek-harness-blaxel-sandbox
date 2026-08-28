/**
 * Every sandbox command moves bytes back as base64, because the SDK log API is
 * line-oriented and would otherwise mangle arbitrary output. This is the one
 * decoder for that framing; callers choose how strict each field has to be.
 */
import { Buffer } from 'node:buffer'

const BASE64_TEXT = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export interface DecodeOptions {
  /** Reject empty output instead of decoding it to zero bytes. */
  requireContent?: boolean
  /** Reject any encoding a canonical encoder would not have produced. */
  requireCanonical?: boolean
}

export function decodeBase64(encoded: string, label: string, opts: DecodeOptions = {}): Buffer {
  const value = encoded.trim()
  if (value === '') {
    if (opts.requireContent === true) throw new Error(`dsh-blaxel: ${label} transport returned empty output`)
    return Buffer.alloc(0)
  }
  if (!BASE64_TEXT.test(value)) throw new Error(`dsh-blaxel: ${label} transport returned invalid base64`)
  const bytes = Buffer.from(value, 'base64')
  if (opts.requireCanonical === true && bytes.toString('base64') !== value) {
    throw new Error(`dsh-blaxel: ${label} transport returned non-canonical base64`)
  }
  return bytes
}

export function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new Error(`dsh-blaxel: ${label} transport is not valid UTF-8`, { cause: error })
  }
}

export function decodeBase64Text(encoded: string, label: string, opts?: DecodeOptions): string {
  return decodeUtf8(decodeBase64(encoded, label, opts), label)
}

/** Splits NUL-terminated transport output, refusing a record cut short. */
export function splitNulTerminated(text: string, label: string): string[] {
  if (text === '') return []
  const fields = text.split('\0')
  if (fields.at(-1) !== '') throw new Error(`dsh-blaxel: ${label} transport is not NUL-terminated`)
  fields.pop()
  return fields
}
