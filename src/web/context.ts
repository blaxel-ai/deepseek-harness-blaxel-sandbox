import type { Context } from '@deepseek-ai/cordis'

export interface BlaxelHttpRequest {
  url?: string
  method?: string
  headers: Record<string, string | string[] | undefined>
  on(event: 'data', listener: (chunk: Buffer) => void): this
  on(event: 'end', listener: () => void): this
  on(event: 'error', listener: (error: Error) => void): this
}

export interface BlaxelHttpResponse {
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string | Uint8Array): void
}

export interface BlaxelWebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: BlaxelHttpRequest, res: BlaxelHttpResponse) => void | Promise<void>
}

export interface BlaxelWebServer {
  register(route: BlaxelWebRoute): () => void
}

type RpcResponse<T> = Promise<{
  result: { ok: true; value: T } | { ok: false; error: { message: string } }
}>

type RpcCall<TPayload, TResult> = (request: { rpcId: string; payload: TPayload }) => RpcResponse<TResult>

/** One listed session; `running` is the authority on an in-flight turn. */
export interface SessionListItem {
  sessionId: string
  running: boolean
  cwd?: string
}

interface ModelSelection {
  provider: string
  model: string
}

interface ConfigurableProvider {
  provider: string
  displayName: string
  settingsNs: string
  settingsPath: string[]
  active: boolean
}

interface CredentialView {
  configured: boolean
  writable: boolean
}

export interface BlaxelApiProxy {
  sessions: {
    /** `workspaceId` and `cwd` are mutually exclusive; `sessionId` adopts a stored log. */
    create: RpcCall<{ workspaceId?: string; cwd?: string; sessionId?: string }, { sessionId: string }>
    list: RpcCall<Record<string, never>, { items: SessionListItem[] }>
    models: RpcCall<{ sessionId: string }, { current: ModelSelection; routable: boolean }>
    rename: RpcCall<{ sessionId: string; title: string }, { title: string; seq: number }>
  }
  workspace: {
    create: RpcCall<{ path: string }, { workspace: { workspaceId: string } }>
  }
  llm: {
    providers: RpcCall<Record<string, never>, { providers: ConfigurableProvider[] }>
  }
  settings: {
    describe: RpcCall<Record<string, never>, { namespaces: { ns: string; value: unknown }[] }>
  }
  credentials: {
    describe: RpcCall<{ refs: string[] }, { credentials: Record<string, CredentialView> }>
    set: RpcCall<{ ref: string; value: string }, Record<string, never>>
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: BlaxelWebServer
    apiProxy: BlaxelApiProxy
  }
}

export type BlaxelWebContext = Context
