import { spawn, type ChildProcess } from 'node:child_process'

export interface DshWeb {
  url: string
  stop(): Promise<void>
}

/** Starts `dsh web` on a free port and resolves once it prints its tokenised URL. */
export async function startDshWeb(): Promise<DshWeb> {
  const child: ChildProcess = spawn('dsh', ['web', '--no-open', '--port', '0'], {
    detached: true,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dsh web did not start in time:\n${output}`)), 60_000)
    const watch = (chunk: Buffer): void => {
      output += chunk.toString()
      const match = /dsh web: (\S+)/.exec(output)
      if (match?.[1] !== undefined) {
        clearTimeout(timer)
        resolve(match[1])
      }
    }
    child.stdout?.on('data', watch)
    child.stderr?.on('data', watch)
    child.once('exit', code => {
      clearTimeout(timer)
      reject(new Error(`dsh web exited with ${String(code)}:\n${output}`))
    })
  })
  return {
    url,
    stop: () => new Promise(resolve => {
      child.once('exit', () => resolve())
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
      }
      setTimeout(resolve, 5_000).unref()
    }),
  }
}
