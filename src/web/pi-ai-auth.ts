import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { credentialKey, credentialRef, isCredentialRefName, isCredentialKeySegment } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { createModels, InMemoryCredentialStore, type Credential } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { BlaxelWebContext } from './context.js'

const catalog = new Map(builtinProviders().map(provider => [provider.id, provider]))

/** Use the adapter's native auth rules without a model request or OAuth refresh. */
export async function inspectPiAiAuth(ctx: BlaxelWebContext, provider: string): Promise<{ configured: boolean; credentialRef?: string }> {
  const credentials = ctx.get('credentials')
  const record = isCredentialKeySegment(provider) ? await credentials?.readRecord(credentialKey('llm-pi-ai', provider)) : undefined
  const store = new InMemoryCredentialStore()
  if (record !== undefined) {
    const credential: Credential = record.kind === 'api-key'
      ? { type: 'api_key', ...(record.key === undefined ? {} : { key: record.key }), ...(record.env === undefined ? {} : { env: { ...record.env } }) }
      : record.payload as unknown as Credential
    await store.modify(provider, async () => credential)
  }
  const environment = launchEnvironmentOf(ctx)
  const queried = new Set<string>()
  const models = createModels({
    credentials: store,
    authContext: {
      async env(name) {
        queried.add(name)
        if (isCredentialRefName(name)) {
          const hit = await credentials?.resolve(credentialRef(name))
          if (hit !== undefined) return hit.value
        }
        return environment.get(name)?.value
      },
      async fileExists(path) {
        const expanded = path === '~' || path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path
        try { await access(expanded); return true } catch { return false }
      },
    },
  })
  const definition = catalog.get(provider)
  if (definition === undefined) throw new Error(`Cannot verify authentication for provider ${provider}`)
  models.setProvider(definition)
  const configured = await models.checkAuth(provider) !== undefined
  // Only offer the inline key form when native discovery asks for one API key.
  const [ref] = queried
  return { configured, ...(!configured && record === undefined && queried.size === 1 && ref?.endsWith('_API_KEY') ? { credentialRef: ref } : {}) }
}
