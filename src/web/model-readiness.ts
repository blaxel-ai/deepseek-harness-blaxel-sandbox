import type { ModelReadiness, ReadyModel } from '../shared/model-readiness.js'
import { modelReadinessMessage } from '../shared/model-readiness.js'
import type { BlaxelWebContext, ModelSelection } from './context.js'

function atPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function apiKeyEnv(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const ref = (value as { apiKeyEnv?: unknown }).apiKeyEnv
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined
}

/** Mirrors the Host's own selection order: pending pick, logged request header, deployment default. */
async function currentSelection(ctx: BlaxelWebContext, sessionId: string): Promise<ModelSelection> {
  const found = await ctx.sessionController.resolveAgent(sessionId)
  if ('error' in found) throw new Error(found.error.message)
  const pending = ctx.sessionProjections?.stateOf(found.agent.session, 'modelSelection')?.pending ?? null
  if (pending !== null) return { provider: pending.provider, model: pending.model }
  const logged = found.agent.session.requestHeader()?.config
  if (logged !== undefined) return { provider: logged.provider, model: logged.model }
  return ctx.agentDefaultModel.currentSelection()
}

/** Resolves the current model, its provider profile, and its value-free credential state. */
export async function inspectModelReadiness(ctx: BlaxelWebContext, sessionId: string): Promise<ModelReadiness> {
  try {
    const { provider, model } = await currentSelection(ctx, sessionId)
    const routable = ctx.llm.listProviders().some(candidate => candidate.id === provider)
    const entry = ctx.llm.listConfigurableProviders().find(candidate => candidate.provider === provider)
    const providerName = entry?.displayName ?? provider
    if (!routable) {
      return {
        kind: 'provider-unavailable',
        provider,
        providerName,
        model,
        message: `${providerName} is not available. Select another model, then retry.`,
      }
    }
    if (entry === undefined || entry.settingsNs === '') {
      return { kind: 'ready', provider, providerName, model }
    }
    const settings = ctx.settingsController.describe()
    const namespace = settings.namespaces.find(candidate => candidate.ns === entry.settingsNs)
    const ref = apiKeyEnv(atPath(namespace?.value, entry.settingsPath))
    if (ref === undefined) return { kind: 'ready', provider, providerName, model }
    const described = await ctx.credentialsController.describe([ref])
    const credential = described[ref]
    if (credential?.configured === true) return { kind: 'ready', provider, providerName, model }
    return {
      kind: 'credential-missing',
      provider,
      providerName,
      model,
      credentialRef: ref,
      writable: credential?.writable === true,
    }
  } catch (error) {
    return {
      kind: 'verification-failed',
      message: `Could not verify the selected model: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export async function requireReadyModel(ctx: BlaxelWebContext, sessionId: string): Promise<ReadyModel> {
  const readiness = await inspectModelReadiness(ctx, sessionId)
  if (readiness.kind !== 'ready') throw new Error(modelReadinessMessage(readiness))
  return readiness
}

/** Stores only the credential currently required by the selected model, then verifies it became usable. */
export async function configureMissingModelCredential(
  ctx: BlaxelWebContext,
  sessionId: string,
  value: string,
): Promise<ModelReadiness> {
  const before = await inspectModelReadiness(ctx, sessionId)
  if (before.kind === 'ready') return before
  if (before.kind !== 'credential-missing') throw new Error(modelReadinessMessage(before))
  if (!before.writable) throw new Error(`${before.providerName} credentials are managed outside DSH and cannot be changed here`)
  await ctx.credentialsController.set(before.credentialRef, value)
  const after = await inspectModelReadiness(ctx, sessionId)
  if (after.kind !== 'ready') throw new Error(modelReadinessMessage(after))
  return after
}
