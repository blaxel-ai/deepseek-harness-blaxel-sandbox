import { expect, it } from 'vitest'
import { returnLanding } from '../src/web/return-landing.js'

it('returns only a same-origin navigation, without credentials or a transfer action', () => {
  expect(returnLanding('/blaxel/return?sessionId=session-123')).toContain('window.location.replace("/?blaxel-return=session-123")')
  for (const id of ['https://attacker.example', '</script>', '../session', 'x'.repeat(201), '']) {
    expect(returnLanding(`/blaxel/return?sessionId=${encodeURIComponent(id)}`)).toBeUndefined()
  }
  expect(returnLanding('/blaxel/return/other?sessionId=abc')).toBeUndefined()
})
