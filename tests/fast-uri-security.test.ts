import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const fastUri = require('fast-uri') as typeof import('fast-uri')
const fastUriVersion = (require('fast-uri/package.json') as { version: string }).version

// `ajv` (a transitive dependency of @modelcontextprotocol/sdk, reached in production
// through @deepseek-ai/dsh-mcp-client's Client construction) resolves its default
// `uriResolver` to exactly this module: ajv/dist/runtime/uri.js does
// `exports.default = require('fast-uri')`. Testing fast-uri's own parse/serialize
// therefore exercises the same code ajv calls for every schema $id/$ref resolution,
// not a copy this test builds itself.
//
// Inputs below are the upstream regression PoCs from fastify/fast-uri's own test
// suite added by the 3.1.7 security release (test/ipv6-validation.test.js and
// test/component-safe-serialization.test.js), not invented here.

describe('fast-uri security fixes (pnpm override -> 3.1.7)', () => {
  it('is pinned to the version that fixes GHSA-58mr-gqgx-xq4g and GHSA-qw65-cvwx-89v3', () => {
    expect(fastUriVersion).toBe('3.1.7')
  })

  it('rejects a host with an unclosed/misplaced IP-literal bracket instead of silently confusing it (GHSA-58mr-gqgx-xq4g)', () => {
    // On fast-uri <= 3.1.6, this parses with userinfo="user", host="[@127.0.0.1"
    // and NO `error`, matching Node's URL/fetch resolving to host 127.0.0.1 while
    // fast-uri's own `.host` reads as something else entirely -- an SSRF-denylist
    // or proxy-routing decision made against `.host` would evaluate the wrong host.
    const malicious = 'http://user@[@127.0.0.1:8123/admin'

    const parsed = fastUri.parse(malicious)
    expect(parsed.error).toBe('URI host is malformed.')

    // normalize/equal must fail closed on the same input.
    expect(fastUri.normalize(malicious)).toBe(malicious)
    expect(fastUri.equal(malicious, malicious)).toBe(false)
    expect(() => fastUri.resolve('http://example.com/', malicious)).toThrow(
      /URI host is malformed\./,
    )
  })

  it('rejects a non-digit port instead of letting it inject authority delimiters on serialize (GHSA-qw65-cvwx-89v3)', () => {
    // On fast-uri <= 3.1.6, this produces the string
    // "http://trusted.example:@127.0.0.1:8124/app" -- the intended host
    // ("trusted.example") is demoted to userinfo and the authority now points
    // at the attacker-controlled "127.0.0.1", with no error raised.
    expect(() =>
      fastUri.serialize({
        scheme: 'http',
        host: 'trusted.example',
        port: '@127.0.0.1:8124',
        path: '/app',
      }),
    ).toThrow(/URI port is malformed\./)

    // A well-formed digit port must still serialize normally.
    expect(fastUri.serialize({ scheme: 'uri', host: 'example.test', port: 8080 })).toBe(
      'uri://example.test:8080',
    )
  })
})
