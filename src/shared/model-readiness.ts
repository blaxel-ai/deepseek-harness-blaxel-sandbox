export interface ReadyModel {
  kind: 'ready'
  provider: string
  providerName: string
  model: string
}

export interface MissingModelCredential {
  kind: 'credential-missing'
  provider: string
  providerName: string
  model: string
  credentialRef: string
  writable: boolean
}

export interface UnavailableModel {
  kind: 'provider-unavailable'
  provider: string
  providerName: string
  model: string
  message: string
}

export interface UnverifiedModel {
  kind: 'verification-failed'
  message: string
}

/** Value-free readiness for the model selected by one native DSH session. */
export type ModelReadiness = ReadyModel | MissingModelCredential | UnavailableModel | UnverifiedModel

/** Vendor casing for providers whose DSH profile carries no display name. */
const VENDOR_NAMES: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
  google: 'Google',
  groq: 'Groq',
  mistral: 'Mistral',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  xai: 'xAI',
}

/** DSH falls back to the raw provider id as displayName; present a proper vendor name instead. */
export function providerDisplayName(provider: string, displayName?: string): string {
  if (displayName !== undefined && displayName.toLowerCase() !== provider.toLowerCase()) return displayName
  return VENDOR_NAMES[provider.toLowerCase()] ?? displayName ?? provider
}

export function modelReadinessMessage(readiness: Exclude<ModelReadiness, ReadyModel>): string {
  if (readiness.kind === 'credential-missing') {
    return `Add your ${readiness.providerName} API key before using this sandbox.`
  }
  return readiness.message
}
