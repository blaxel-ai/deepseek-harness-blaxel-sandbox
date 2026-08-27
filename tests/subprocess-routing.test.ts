import { describe, expect, it } from 'vitest'
import { remoteArgv, remoteExecutable } from '../src/subprocess/service.js'

describe('remote subprocess routing', () => {
  it('removes the macOS sandbox wrapper before Linux execution', () => {
    expect(remoteArgv([
      'sandbox-exec',
      '-p',
      '(version 1) (allow default)',
      '--',
      'bash',
      '-c',
      'pwd',
    ])).toEqual(['bash', '-c', 'pwd'])
  })

  it('preserves ordinary subprocess arguments', () => {
    expect(remoteArgv(['bash', '-c', 'pwd'])).toEqual(['bash', '-c', 'pwd'])
  })

  it('uses the sandbox ripgrep instead of the packaged host binary', () => {
    const hostRipgrep = '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg'
    expect(remoteArgv([
      hostRipgrep,
      '--files',
    ])).toEqual(['rg', '--files'])
    expect(remoteExecutable(hostRipgrep)).toBe('rg')
  })

  it('rejects a malformed sandbox wrapper', () => {
    expect(() => remoteArgv(['sandbox-exec', '-p', 'profile'])).toThrow('invalid sandbox-exec wrapper')
  })
})
