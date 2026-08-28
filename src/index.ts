export { BlaxelRuntime } from './runtime/service.js'
export type { Config as BlaxelRuntimeConfig } from './runtime/service.js'
export { mapWorkspacePath } from './runtime/paths.js'
export { shellQuote } from './shared/shell.js'
export { BlaxelFileSystem } from './filesystem/service.js'
export { BlaxelSubprocessRuntime } from './subprocess/service.js'

/** Host no-op used to activate this package's Web client module. */
export function apply(): void {}
