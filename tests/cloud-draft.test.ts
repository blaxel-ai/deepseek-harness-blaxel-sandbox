import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { DraftStore, draftRequest, validateDraft } from '../src/cloud/draft.js'
import { requireUnchangedDraft } from '../src/client/useSessionDraft.js'
import type { BlaxelHttpRequest, BlaxelHttpResponse } from '../src/web/context.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function store() { const path = await mkdtemp(join(tmpdir(), 'dsh-draft-test-')); directories.push(path); return { path, store: new DraftStore(path) } }
async function request(store: DraftStore, body: unknown, writable = true) {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', headers: { 'x-dsh-blaxel-action': 'draft' } })
  let status = 0, value: any
  const res = { writeHead(code: number) { status = code }, end(data: string) { value = JSON.parse(data) } }
  await draftRequest(req as unknown as BlaxelHttpRequest, res as unknown as BlaxelHttpResponse, store, () => writable)
  return { status, value }
}

describe('cloud composer drafts', () => {
  it('prevents navigation from discarding text or images edited during handoff', () => {
    const sent = { text: 'Keep working', images: [] }
    expect(() => requireUnchangedDraft(sent, { ...sent })).not.toThrow()
    expect(() => requireUnchangedDraft(sent, { ...sent, text: 'New instructions' })).toThrow('still here')
    expect(() => requireUnchangedDraft(sent, { ...sent, images: [{ mediaType: 'image/png', data: 'AQID' }] })).toThrow('still here')
    expect(() => requireUnchangedDraft(undefined, sent)).toThrow('still here')
  })
  it('persists an unsent draft and pending image without creating a user message', async () => {
    const { path, store: first } = await store()
    const draft = { text: 'Continue this later', images: [{ mediaType: 'image/png' as const, data: 'AQID', name: 'invoice.png' }] }
    const saved = await first.save('session-1', draft)
    expect(await new DraftStore(path).get('session-1')).toEqual(saved)
    const file = join(path, createHash('sha256').update('session-1').digest('hex') + '.json')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(file, 'utf8')).draft).toEqual(draft)
  })
  it('serializes competing saves and preserves the first acknowledged draft', async () => {
    const { store: drafts } = await store()
    const results = await Promise.all(['first', 'second'].map(text => request(drafts, { sessionId: 'one', draft: { text, images: [] } })))
    expect(results.map(item => item.status)).toEqual([200, 409])
    const saved = await drafts.get('one')
    expect(saved?.draft.text).toBe('first')
    expect((await request(drafts, { sessionId: 'one', revision: saved!.revision, draft: { text: 'revised', images: [] } })).status).toBe(200)
  })
  it('allows draft reads while the other host owns execution but rejects stale writes', async () => {
    const { store: drafts } = await store()
    await drafts.save('one', { text: 'kept in cloud', images: [] })
    expect((await request(drafts, { sessionId: 'one' }, false)).value.saved.draft.text).toBe('kept in cloud')
    expect((await request(drafts, { sessionId: 'one', draft: { text: '', images: [] } }, false)).status).toBe(409)
    expect((await drafts.get('one'))?.draft.text).toBe('kept in cloud')
  })
  it('rejects malformed image payloads and oversized text before storage', () => {
    expect(() => validateDraft({ text: 'x', images: [{ mediaType: 'text/html', data: 'AQID' }] })).toThrow('Invalid draft image')
    expect(() => validateDraft({ text: 'x', images: [{ mediaType: 'image/png', data: '%%%=' }] })).toThrow('Invalid draft image')
    expect(() => validateDraft({ text: 'x'.repeat(1024 * 1024 + 1), images: [] })).toThrow('limit')
  })
})
