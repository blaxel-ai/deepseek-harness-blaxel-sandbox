import { builtinProviders } from '@earendil-works/pi-ai/providers/all'

type PiAiProvider = ReturnType<typeof builtinProviders>[number]

// pi-ai 1.0.3 renamed the Azure provider. The host's pi-ai can be older or newer than ours, so accept either id.
const ALIASES: Record<string, string> = { 'azure-openai-responses': 'azure', azure: 'azure-openai-responses' }

const catalog = new Map(builtinProviders().map(provider => [provider.id, provider]))

/** The bundled pi-ai provider for a host provider id, whichever pi-ai version named it. */
export function piAiProvider(id: string): PiAiProvider | undefined {
  const definition = catalog.get(id) ?? catalog.get(ALIASES[id] ?? '')
  // Keep the host's id so auth checks and credential lookups use the name the host routes by.
  return definition === undefined || definition.id === id ? definition : { ...definition, id }
}
