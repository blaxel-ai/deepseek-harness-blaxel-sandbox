import { describe, expect, it } from 'vitest'
import { shellQuote } from '../packages/dsh-blaxel/dist/index.js'

describe('dsh-blaxel', () => {
  it('quotes POSIX arguments without interpolation', () => {
    expect(shellQuote("a'b; $(touch /tmp/nope)\n")).toBe("'a'\"'\"'b; $(touch /tmp/nope)\n'")
  })
})
