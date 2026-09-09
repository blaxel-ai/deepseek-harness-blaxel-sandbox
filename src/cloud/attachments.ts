import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'

export const MAX_TRANSFER_BYTES = 64 * 1024 * 1024
export function requireTransferSize(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_TRANSFER_BYTES - 4096) {
    throw new Error('The conversation, images and unsent draft exceed the 64 MiB transfer limit')
  }
}
const MAX_IMAGE_BYTES = 32 * 1024 * 1024
export interface TransferImage { ref: ImageAttachmentRef; data: string }

/** Follow durable image references only; quoted text and paths are never treated as files. */
export function sessionImages(sessions: readonly SessionInspection[]): ImageAttachmentRef[] {
  const refs = new Map<string, ImageAttachmentRef>()
  const visit = (value: unknown, depth: number): void => {
    if (depth > 64) throw new Error('The session contains attachment data nested beyond the transfer limit')
    if (typeof value !== 'object' || value === null) return
    const record = value as Record<string, unknown>
    if (record.type === 'image' && typeof record.attachment === 'object' && record.attachment !== null) {
      const ref = record.attachment as ImageAttachmentRef
      if (typeof ref.attachmentId !== 'string' || !Number.isSafeInteger(ref.bytes) || ref.bytes < 1) throw new Error('The conversation contains an invalid image reference')
      refs.set(ref.attachmentId, ref)
      if (refs.size > 200) throw new Error('This session exceeds the 200-image handoff limit')
    }
    for (const child of Object.values(record)) visit(child, depth + 1)
  }
  for (const session of sessions) visit(session.events, 0)
  if ([...refs.values()].reduce((sum, ref) => sum + ref.bytes, 0) > MAX_IMAGE_BYTES) throw new Error('This session exceeds the 32 MiB image handoff limit')
  return [...refs.values()]
}

export async function exportImages(store: AttachmentStore, sessions: readonly SessionInspection[]): Promise<TransferImage[]> {
  const result: TransferImage[] = []
  for (const ref of sessionImages(sessions)) {
    const image = await store.readImage(ref)
    result.push({ ref, data: Buffer.from(image.data).toString('base64') })
  }
  if (Buffer.byteLength(JSON.stringify({ sessions, images: result })) > MAX_TRANSFER_BYTES - 1024 * 1024) {
    throw new Error('Conversation history and attachments together exceed the 63 MiB handoff limit')
  }
  return result
}

export async function importImages(store: AttachmentStore, sessions: readonly SessionInspection[], images: readonly TransferImage[] = []): Promise<void> {
  const expected = sessionImages(sessions)
  if (!Array.isArray(images) || images.length > 200) throw new Error('The image transfer is invalid')
  const byId = new Map(images.map(image => [image.ref?.attachmentId, image]))
  for (const ref of expected) {
    const image = byId.get(ref.attachmentId)
    if (image === undefined || typeof image.data !== 'string' || image.data.length > Math.ceil(ref.bytes / 3) * 4) throw new Error('An attached image is missing from the transfer')
    const data = Buffer.from(image.data, 'base64')
    if (data.length !== ref.bytes) throw new Error('An attached image is incomplete')
    const saved = await store.saveImage({ data, mediaType: ref.mediaType, name: ref.name })
    if (saved.attachmentId !== ref.attachmentId) throw new Error('An attached image could not be preserved exactly')
    await store.readImage(ref)
  }
}
