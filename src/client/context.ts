import type { Context } from '@deepseek-ai/cordis'

export interface ClientSessionListState {
  ids: string[]
  byId: Record<string, { cwd?: string; blank: boolean; displayTitle?: string } | undefined>
  current?: string
}

/** The part of DSH's per-session snapshot the Blaxel surfaces read. */
export interface ClientSessionSnapshot {
  sessionId: string
  running: boolean
}

/**
 * Standard props DSH hands every entry in a session-scoped slot (DSH 0.1.2):
 * the session identity plus selector hooks, never a plain session object.
 */
export interface SessionSlotProps {
  sessionId: string
  useSession: <T>(selector: (snapshot: ClientSessionSnapshot) => T) => T
  useSessions: <T>(selector: (state: ClientSessionListState) => T) => T
}

export interface ClientSessions {
  list: {
    getSnapshot(): ClientSessionListState
    subscribe(listener: () => void): () => void
  }
  open(sessionId: string): void
}

export interface ClientConversation {
  blocks: {
    set(sessionId: string, block: { reason: string } | undefined): void
    storeFor(sessionId: string): { getSnapshot(): { reason: string } | undefined }
  }
}

interface ClientSlots {
  register(options: {
    name: string
    id?: string
    order?: number
    label?: string | (() => string)
    [key: string]: unknown
  }, component: unknown): () => void
  inject(key: string, callback: () => () => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    slots: ClientSlots
  }
}

export type BlaxelClientContext = Omit<Context, 'sessions' | 'conversation'> & {
  sessions: ClientSessions
  conversation: ClientConversation
}
