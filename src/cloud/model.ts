import { credentialKey, credentialRef, isCredentialKeySegment, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { BlaxelWebContext } from '../web/context.js'
import { requireReadyModel } from '../web/model-readiness.js'

const CLOUD_KEY = 'DSH_BLAXEL_MODEL_KEY'

/** Only the chosen model's credential crosses the boundary, in process environment. */
export async function cloudModel(ctx: BlaxelWebContext, sessionId: string): Promise<{
  settings: Record<string, unknown>
  env: Record<string, string>
}> {
  const selection = await requireReadyModel(ctx, sessionId)
  const entry = ctx.llm.listConfigurableProviders().find(item => item.provider === selection.provider)
  const ns = entry?.settingsNs
  if (ns !== 'llm-pi-ai' && ns !== 'llm-deepseek') {
    throw new Error('Cloud handoff requires a portable API-key model in Settings > Models')
  }
  const namespace = ctx.settingsController.describe().namespaces.find(item => item.ns === ns)?.value
  let value: unknown = namespace
  for (const key of entry?.settingsPath ?? []) value = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined
  const profile = typeof value === 'object' && value !== null ? structuredClone(value) as Record<string, unknown> : {}
  const credentials = ctx.get('credentials')
  const resolve = async (name: string): Promise<string | undefined> => {
    if (!isCredentialRefName(name)) return undefined
    return (await credentials?.resolve(credentialRef(name)))?.value ?? launchEnvironmentOf(ctx).get(name)?.value
  }
  let key: string | undefined
  if (typeof profile.apiKeyEnv === 'string') key = await resolve(profile.apiKeyEnv)
  else if (ns === 'llm-deepseek') key = await resolve('DEEPSEEK_API_KEY')
  else {
    const definition = builtinProviders().find(item => item.id === selection.provider)
    const record = isCredentialKeySegment(selection.provider) ? await credentials?.readRecord(credentialKey(ns, selection.provider)) : undefined
    if (record?.kind === 'grant') throw new Error('This model uses a local authorization grant. Select an API-key model before cloud handoff.')
    const auth = await definition?.auth?.apiKey?.resolve({
      ctx: { env: resolve, fileExists: async () => false },
      ...(record?.kind === 'api-key' ? { credential: { type: 'api_key' as const, key: record.key, env: record.env } } : {}),
      signal: new AbortController().signal,
    })
    key = typeof auth?.auth.apiKey === 'string' ? auth.auth.apiKey : undefined
  }
  if (!key) throw new Error('The selected model has no portable API key. Configure one in Settings > Models before moving the session.')
  for (const field of ['baseURL', 'baseUrl']) {
    if (typeof profile[field] !== 'string') continue
    const endpoint = new URL(profile[field])
    if (['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) throw new Error('The model endpoint is on this computer. Choose a model endpoint reachable from Blaxel before handoff.')
  }
  profile.apiKeyEnv = CLOUD_KEY
  return {
    settings: {
      [ns]: ns === 'llm-pi-ai' ? { providers: { [selection.provider]: profile } } : profile,
      'agent-default-model': { provider: selection.provider, model: selection.model },
      'ui-onboarding': { welcomeNoticeVersion: '2026-08-13.1' },
    },
    env: { [CLOUD_KEY]: key },
  }
}
