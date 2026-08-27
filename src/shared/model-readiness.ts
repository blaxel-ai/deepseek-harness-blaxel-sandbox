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

export function modelReadinessMessage(readiness: Exclude<ModelReadiness, ReadyModel>): string {
  if (readiness.kind === 'credential-missing') {
    return `Add your ${readiness.providerName} API key before using this sandbox.`
  }
  return readiness.message
}
