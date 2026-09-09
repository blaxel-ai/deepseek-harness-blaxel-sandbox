import { describe, expect, it, vi } from 'vitest'
import { CollectedReader } from '../src/subprocess/collected-reader.js'

describe('bounded subprocess diagnostics', () => {
  it('retains no output when the caller requests a zero-byte tail', () => {
    const reader = new CollectedReader({ maxBytes: 0 })
    reader.push('x'.repeat(1024 * 1024))
    expect(reader.readFrom(0)).toEqual({ text: '', nextOffset: 1024 * 1024, lossy: true })
  })

  it('keeps a capped tail and never offers a truncated spill as complete output', async () => {
    const reader = new CollectedReader({ maxBytes: 4, spill: { maxBytes: 8 } }, '/workspace/spill')
    reader.push('12345678')
    reader.push('9')
    reader.push('0')
    reader.finish()
    const writeBinary = vi.fn()
    await reader.persist({ fs: { writeBinary } } as never)
    expect(reader.readFrom(0)).toEqual({ text: '7890', nextOffset: 10, lossy: true })
    expect(writeBinary).not.toHaveBeenCalled()
  })
})
