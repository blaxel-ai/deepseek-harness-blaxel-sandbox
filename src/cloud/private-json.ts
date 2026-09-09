import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Publish a flushed private checkpoint atomically; never expose a torn JSON file. */
export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = path + '.' + randomUUID()
  try {
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(value)); await file.sync() } finally { await file.close() }
    await rename(temporary, path)
    const directory = await open(dirname(path), 'r')
    try { await directory.sync() } finally { await directory.close() }
  } finally { await rm(temporary, { force: true }) }
}
