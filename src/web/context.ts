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

interface RpcEndpoint<TPayload, TResult> {
  create(request: { rpcId: string; payload: TPayload }): RpcResponse<TResult>
}

export interface BlaxelApiProxy {
  sessions: RpcEndpoint<{ workspaceId: string }, { sessionId: string }>
  workspace: RpcEndpoint<{ path: string }, { workspace: { workspaceId: string } }>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: BlaxelWebServer
    apiProxy: BlaxelApiProxy
  }
}

export type BlaxelWebContext = Context
