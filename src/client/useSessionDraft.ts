import { useEffect, useRef, useState } from 'react'
import type { ClientConversation, SessionSlotProps } from './context.js'
import type { SavedDraft, SessionDraft } from '../cloud/draft.js'
import { sessionDraft } from './api.js'

const saves = new Map<string, () => Promise<void>>()
const clears = new Map<string, () => () => Promise<void>>()
export async function flushSessionDraft(id: string): Promise<void> { const save = saves.get(id); if (save === undefined) throw new Error('The draft is still loading. Try moving the session again in a moment.'); await save() }
export async function prepareDraftHandoff(id: string): Promise<() => Promise<void>> {
  await flushSessionDraft(id)
  const clear = clears.get(id)
  if (clear === undefined) throw new Error('The session draft changed during handoff. Please retry.')
  return clear()
}
const equal = (a: SessionDraft, b: SessionDraft): boolean => JSON.stringify(a) === JSON.stringify(b)
export function requireUnchangedDraft(transferred: SessionDraft | undefined, current: SessionDraft): void {
  if (transferred === undefined || !equal(transferred, current)) throw new Error('Your draft changed while the session moved. It is still here. Save these new edits before opening the cloud session.')
}

/** Native composer APIs own text and images; no DOM or browser-storage scraping. */
export function useSessionDraft(props: SessionSlotProps, conversation: ClientConversation, writable: boolean): string | undefined {
  const input = props.useInput(state => state)
  const latest = useRef(input)
  latest.current = input
  const [error, setError] = useState<string>()
  const [ready, setReady] = useState(false)
  const saved = useRef<SavedDraft>()
  const chain = useRef<Promise<void>>(Promise.resolve())
  const read = async (): Promise<SessionDraft> => {
    const current = latest.current
    if (current.phase !== 'plain') throw new Error('Wait for the current prompt submission to finish before moving its draft')
    return { text: current.draft, images: [...await conversation.serializeDraftImages(current.imageIds)] }
  }
  useEffect(() => {
    if (!writable) { setReady(false); return }
    let active = true
    const initialize = async (): Promise<void> => {
      const remote = await sessionDraft(props.sessionId)
      if (!active) return
      const local = await read()
      if (remote !== undefined && !equal(remote.draft, local)) {
        // Keep edits typed in this browser as well as the transferred draft.
        const text = !local.text || remote.draft.text === local.text ? remote.draft.text
          : !remote.draft.text ? local.text : remote.draft.text + '\n\n' + local.text
        const existing = new Set(local.images.map(image => JSON.stringify(image)))
        const files = remote.draft.images.filter(image => !existing.has(JSON.stringify(image))).map(image => {
          const binary = atob(image.data)
          return new File([Uint8Array.from(binary, char => char.charCodeAt(0))], image.name ?? 'image', { type: image.mediaType })
        })
        const added = conversation.createDraftImages(files)
        if (!props.inputActions.addImages(added.map(image => image.id))) {
          for (const image of added) conversation.releaseDraftImage(image.id)
          throw new Error('The composer is busy. Reload after the prompt finishes to restore its unsent images.')
        }
        props.inputActions.setDraft(text)
        if (local.text && remote.draft.text && remote.draft.text !== local.text) setError('Both unsent drafts were recovered. Review the combined text before sending.')
      }
      saved.current = remote
      if (active) setReady(true)
    }
    void initialize().catch(error => { if (active) setError(error instanceof Error ? error.message : 'Could not recover the draft') })
    return () => { active = false }
  }, [props.sessionId, writable])
  useEffect(() => {
    if (!ready || !writable) return
    const save = async (): Promise<void> => {
      const operation = chain.current.catch(() => undefined).then(async () => {
        const draft = await read()
        if (saved.current !== undefined && equal(saved.current.draft, draft)) return
        saved.current = await sessionDraft(props.sessionId, draft, saved.current?.revision)
      })
      chain.current = operation
      await operation
    }
    const clear = (): (() => Promise<void>) => {
      const transferred = saved.current?.draft
      return async () => {
        requireUnchangedDraft(transferred, await read())
        props.inputActions.setDraft('')
        for (const id of latest.current.imageIds) { props.inputActions.removeImage(id); conversation.releaseDraftImage(id) }
      }
    }
    saves.set(props.sessionId, save)
    clears.set(props.sessionId, clear)
    const timer = setTimeout(() => { void save().catch(error => setError(error instanceof Error ? error.message : 'Draft not saved')) }, 300)
    return () => { clearTimeout(timer); if (saves.get(props.sessionId) === save) saves.delete(props.sessionId); if (clears.get(props.sessionId) === clear) clears.delete(props.sessionId) }
  }, [props.sessionId, ready, writable, input.draft, input.imageIds])
  return error
}
