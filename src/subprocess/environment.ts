import { SENSITIVE_ENV_PATTERN } from '@deepseek-ai/dsh-subprocess'
import { shellQuote } from '../shared/shell.js'

const SANDBOX_ENV_ALLOWLIST = new Set(['HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'PATH', 'SHELL', 'TERM', 'TMPDIR', 'USER'])

export function environmentFor(
  ambient: ReadonlyMap<string, string>,
  explicit: NodeJS.ProcessEnv | undefined,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of ambient) {
    if (SANDBOX_ENV_ALLOWLIST.has(key)) result[key] = value
  }
  for (const [key, value] of Object.entries(explicit ?? {})) {
    if (key.length === 0 || key.includes('=') || key.includes('\0') || value?.includes('\0') === true) {
      throw new Error('dsh-subprocess-blaxel: environment entries require non-empty NUL-free names without = and NUL-free values')
    }
    if (key.toUpperCase().startsWith('DSH_') || SENSITIVE_ENV_PATTERN.test(key)) continue
    if (value !== undefined && process.env[key] === value) continue
    if (value === undefined) delete result[key]
    else result[key] = value
  }
  return result
}

/** `env -i` assignments, quoted so no value can be read as shell syntax. */
export function envArgs(env: Record<string, string>): string {
  return Object.entries(env).map(([key, value]) => shellQuote(`${key}=${value}`)).join(' ')
}

export function argvArgs(argv: readonly string[]): string {
  return argv.map(shellQuote).join(' ')
}

export function argvCommand(argv: readonly string[], env: Record<string, string>, cwd: string, fifo?: string): string {
  const input = fifo === undefined ? ' </dev/null' : ` < ${shellQuote(fifo)}`
  return [
    `cd -- ${shellQuote(cwd)} &&`,
    `child='';`,
    `trap 'test -n "$child" && kill -TERM -"$child" 2>/dev/null; wait "$child" 2>/dev/null; exit 143' TERM INT HUP;`,
    `setsid env -i ${envArgs(env)} ${argvArgs(argv)}${input} &`,
    `child=$!;`,
    `wait "$child"`,
  ].join(' ')
}
