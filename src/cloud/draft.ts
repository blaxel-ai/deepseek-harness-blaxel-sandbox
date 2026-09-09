import { writePrivateJson } from './private-json.js'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { BlaxelHttpRequest, BlaxelHttpResponse } from '../web/context.js'
import { readJsonBody, writeJson } from '../web/http.js'
import { defaultBindingStorePath } from '../session-runtime/binding-store.js'

export interface DraftImage { mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string; name?: string }
export interface SessionDraft { text: string; images: DraftImage[] }
export interface SavedDraft { revision: string; draft: SessionDraft }
export const MAX_DRAFT_BYTES = 12 * 1024 * 1024

export function validateDraft(value: unknown): SessionDraft {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid session draft')
  const draft = value as SessionDraft
  if (typeof draft.text !== 'string' || draft.text.length > 1024 * 1024 || !Array.isArray(draft.images) || draft.images.length > 20
    || Buffer.byteLength(JSON.stringify(draft)) > MAX_DRAFT_BYTES) throw new Error('Draft exceeds the 1 MiB text or 12 MiB attachment transfer limit')
  const images = draft.images.map(image => {
    if (typeof image !== 'object' || image === null || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mediaType)
      || typeof image.data !== 'string' || image.data.length === 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)
      || (image.name !== undefined && (typeof image.name !== 'string' || image.name.length > 512))) throw new Error('Invalid draft image')
    return { mediaType: image.mediaType, data: image.data, ...(image.name === undefined ? {} : { name: image.name }) }
  })
  return { text: draft.text, images }
}

/** Host-owned drafts survive browser navigation and cloud host restarts. */
export class DraftStore {
  constructor(private readonly directory = join(dirname(defaultBindingStorePath()), 'blaxel-drafts')) {}
  private path(id: string): string { return join(this.directory, createHash('sha256').update(id).digest('hex') + '.json') }
  async get(id: string): Promise<SavedDraft | undefined> {
    try {
      const record = JSON.parse(await readFile(this.path(id), 'utf8')) as SavedDraft
      return { revision: record.revision, draft: validateDraft(record.draft) }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
  async save(id: string, draft: SessionDraft): Promise<SavedDraft> {
    const record = { revision: randomUUID(), draft: validateDraft(draft) }
    await writePrivateJson(this.path(id), record)
    return record
  }
}

const writes = new Map<string, Promise<unknown>>()
/** Called only after the host's authentication and same-origin checks. */
export async function draftRequest(req: BlaxelHttpRequest, res: BlaxelHttpResponse, store: DraftStore, writable: (id: string) => boolean): Promise<void> {
  try {
    if (req.method !== 'POST' || req.headers['x-dsh-blaxel-action'] !== 'draft') return writeJson(res, 403, { ok: false, error: 'action-not-authorized' })
    const body = await readJsonBody(req, MAX_DRAFT_BYTES + 4096)
    if (typeof body.sessionId !== 'string' || !/^[^/\\\0]{1,512}$/.test(body.sessionId)) throw new Error('Invalid session identity')
    const id = body.sessionId
    const pending = writes.get(id) ?? Promise.resolve()
    const operation = pending.catch(() => undefined).then(async () => {
      const saved = await store.get(id)
      if (body.draft === undefined) return saved
      if (!writable(id)) throw new Error('This draft is owned by the other session host; reopen that session to continue editing')
      if (body.revision !== saved?.revision) throw new Error('The draft changed in another browser. Your unsent draft is still here; reload to recover both versions.')
      return await store.save(id, validateDraft(body.draft))
    })
    writes.set(id, operation)
    try { writeJson(res, 200, { ok: true, saved: await operation }) }
    finally { if (writes.get(id) === operation) writes.delete(id) }
  } catch (error) { writeJson(res, 409, { ok: false, error: error instanceof Error ? error.message : 'Could not save the draft' }) }
}
