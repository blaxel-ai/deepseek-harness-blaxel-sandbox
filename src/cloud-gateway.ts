import { TypertGatewayService, TypertGatewayError, type InvokeRemoteRequest } from '@deepseek-ai/dsh-api-gateway'

export interface CloudExecutionOwner {
  blocks(sessionId: string): boolean
  blocksAll?(): boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context { blaxelCloud: CloudExecutionOwner }
}

const READS = new Set(['session/list', 'session/search', 'session/page', 'session/follow', 'session/control', 'session/attachment', 'session/modelCatalog'])

/** Check named identity fields, including nested request DTOs, before dispatch can mutate a Session. */
export function addressedSessions(args: Readonly<Record<string, unknown>>): string[] {
  const result = new Set<string>()
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8 || typeof value !== 'object' || value === null) return
    for (const [name, child] of Object.entries(value)) {
      if (['sessionId', 'agentId', 'parentSessionId', 'childSessionId', 'agent', 'session'].includes(name) && typeof child === 'string') result.add(child)
      else if (name !== 'content' && name !== 'images') visit(child, depth + 1)
    }
  }
  visit(args, 0)
  return [...result]
}

/** Keep native authentication, argument validation and dispatch; add one execution-owner fence. */
export default class BlaxelCloudGateway extends TypertGatewayService {
  static inject = [...TypertGatewayService.inject, 'blaxelCloud']

  async invoke(request: InvokeRemoteRequest): Promise<unknown> {
    const endpoint = `${request.namespace}/${request.method}`
    if (!READS.has(endpoint) && (this.ctx.blaxelCloud.blocksAll?.() === true || addressedSessions(request.args).some(id => this.ctx.blaxelCloud.blocks(id)))) {
      throw new TypertGatewayError('gateway/invocation-unavailable', endpoint, 'This session is moving or running on Blaxel. Open the cloud session, or move it back before making local changes.')
    }
    return await super.invoke(request)
  }
}
