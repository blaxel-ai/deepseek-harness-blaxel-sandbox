import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const qs = require('qs') as typeof import('qs')
const qsVersion = (require('qs/package.json') as { version: string }).version

// qs reaches this repo's production dependency tree transitively through
// @modelcontextprotocol/sdk's express/body-parser (via @apify/mcpc, @blaxel/core
// and @deepseek-ai/dsh-mcp-client). This repo's own code never constructs an
// express-based MCP HTTP server (proxy-server.js uses raw node:http +
// StreamableHTTPServerTransport instead), so the express request-parsing path
// that actually invokes qs is not exercised by this process today -- see the
// tier-B report for the reachability trace. The package is still bumped because
// the fix is a same-minor, non-breaking, zero-cost override, and this test
// exercises qs's own parse/stringify directly so a future consumer that does
// wire up express (or an override drift) is protected regardless.
//
// PoCs below are copied from the upstream security advisories themselves
// (GHSA-4mjr-xmp4-gh2g and GHSA-x5fp-wj9c-mxmx), not invented here.

describe('qs security fixes (pnpm override -> 6.16.0)', () => {
  it('is pinned to the version that fixes GHSA-4mjr-xmp4-gh2g and GHSA-x5fp-wj9c-mxmx', () => {
    expect(qsVersion).toBe('6.16.0')
  })

  it('does not throw when re-serializing a parsed object carrying a poisoned constructor.isBuffer key (GHSA-4mjr-xmp4-gh2g)', () => {
    // On qs <= 6.15.3, qs.parse keeps `constructor` as an own key under
    // plainObjects/allowPrototypes, and stringify's utils.isBuffer then calls
    // the resulting non-function `constructor.isBuffer` and throws -- turning
    // a single untrusted query string into an uncaught TypeError DoS.
    const untrustedQueryString = 'x%5Bconstructor%5D%5BisBuffer%5D=y' // x[constructor][isBuffer]=y

    const parsed = qs.parse(untrustedQueryString, { plainObjects: true })
    expect(() => qs.stringify(parsed)).not.toThrow()
    expect(qs.stringify(parsed)).toBe(untrustedQueryString)
  })

  it('enforces arrayLimit on a bracket-key comma-separated value instead of silently overflowing it (GHSA-x5fp-wj9c-mxmx)', () => {
    // On qs <= 6.15.3, the `a[]=1,2,3,4` form bypasses arrayLimit entirely
    // (the equivalent `a=1,2,3,4` correctly throws), letting a single
    // parameter materialize an unbounded array.
    expect(() =>
      qs.parse('a[]=1,2,3,4', { comma: true, arrayLimit: 3, throwOnLimitExceeded: true }),
    ).toThrow(RangeError)
  })
})
