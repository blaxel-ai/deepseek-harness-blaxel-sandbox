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

/** One listed session; `running` is the authority on an in-flight turn. */
export interface SessionListItem {
  sessionId: string
  running: boolean
  cwd?: string
}

export interface ModelSelection {
  provider: string
  model: string
}

interface ConfigurableProvider {
  provider: string
  displayName: string
  settingsNs: string
  settingsPath: readonly string[]
}

interface CredentialView {
  configured: boolean
  writable: boolean
}

/** The live Agent resolved for a session; only the folded request header is read. */
export interface BlaxelResolvedAgent {
  session: { requestHeader(): { config: ModelSelection } | undefined }
}

/** Host owner of session lifecycle (`@deepseek-ai/dsh-api-session-controller`). */
export interface BlaxelSessionController {
  list(request: Record<string, never>, signal: AbortSignal): Promise<{ items: readonly SessionListItem[] }>
  /** `workspaceId` and `cwd` are mutually exclusive; `sessionId` adopts a stored log. */
  create(request: { workspaceId?: string; cwd?: string; sessionId?: string }): Promise<{ sessionId: string }>
  resolveAgent(sessionId: string): Promise<{ agent: BlaxelResolvedAgent } | { error: { message: string } }>
}

/** Host owner of workspace navigation (`@deepseek-ai/dsh-api-workspace-controller`). */
export interface BlaxelWorkspaceController {
  create(request: { path: string }): Promise<{ workspace: { workspaceId: string } }>
}

/** Host owner of redacted settings reads (`@deepseek-ai/dsh-api-settings-controller`). */
export interface BlaxelSettingsController {
  describe(): { namespaces: { ns: string; value: unknown }[] }
}

/** Host owner of value-free credential state (`@deepseek-ai/dsh-api-settings-controller`). */
export interface BlaxelCredentialsController {
  describe(refs: string[]): Promise<Record<string, CredentialView>>
  set(ref: string, value: string): Promise<void>
}

/** Deployment default model (`@deepseek-ai/dsh-agent-default-model`). */
export interface BlaxelAgentDefaultModel {
  currentSelection(): ModelSelection
}

/** Optional pending model pick projected for a session before its next request. */
export interface BlaxelSessionProjections {
  stateOf(session: unknown, key: 'modelSelection'): { pending: ModelSelection | null } | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: BlaxelWebServer
    sessionController: BlaxelSessionController
    workspaceController: BlaxelWorkspaceController
    settingsController: BlaxelSettingsController
    credentialsController: BlaxelCredentialsController
    agentDefaultModel: BlaxelAgentDefaultModel
    sessionProjections?: BlaxelSessionProjections
  }
}

export type BlaxelWebContext = Context
