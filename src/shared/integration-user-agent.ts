import { createRequire } from 'node:module'
import { settings } from '@blaxel/core'

const require = createRequire(import.meta.url)
const { version } = require('../../package.json') as { version: string }

/** Product token appended to the Blaxel SDK User-Agent so Blaxel can attribute traffic to this integration. */
export const INTEGRATION_PRODUCT_TOKEN = `deepseek-harness-blaxel-sandbox/${version}`

const INSTALLED = Symbol.for('blaxel.integrationUserAgent')

type HeaderSource = { headers: Record<string, string> }

/**
 * Appends the integration product token to every Blaxel request's User-Agent.
 *
 * The SDK builds headers from one getter that both control-plane calls and
 * sandbox data-plane calls read, so shadowing it on the singleton covers every
 * request without touching credentials or adding any other header. Idempotent.
 */
export function installIntegrationUserAgent(target: HeaderSource = settings): void {
  const marked = target as HeaderSource & { [INSTALLED]?: true }
  if (marked[INSTALLED] === true) return
  const prototype = Object.getPrototypeOf(target) as object
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'headers')
  const base = descriptor?.get
  if (descriptor === undefined || base === undefined) return
  Object.defineProperty(target, 'headers', {
    configurable: true,
    enumerable: descriptor.enumerable,
    get(): Record<string, string> {
      const headers = base.call(target) as Record<string, string>
      const agent = headers['User-Agent']
      if (agent === undefined || agent.endsWith(INTEGRATION_PRODUCT_TOKEN)) return headers
      return { ...headers, 'User-Agent': `${agent} ${INTEGRATION_PRODUCT_TOKEN}` }
    },
  })
  Object.defineProperty(marked, INSTALLED, { value: true, configurable: true })
}

installIntegrationUserAgent()
