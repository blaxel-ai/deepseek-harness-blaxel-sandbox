import type { Context } from '@deepseek-ai/cordis'

export interface ClientSessionListState {
  ids: string[]
  byId: Record<string, { cwd?: string; blank: boolean } | undefined>
  current?: string
}

export interface ClientSessions {
  list: {
    getSnapshot(): ClientSessionListState
    subscribe(listener: () => void): () => void
  }
  open(sessionId: string): void
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

export type BlaxelClientContext = Omit<Context, 'sessions'> & { sessions: ClientSessions }
