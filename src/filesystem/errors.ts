/** Maps sandbox and transport failures onto the DSH `FsError` vocabulary. */
import { FsError } from '@deepseek-ai/dsh-fs'

const BINARY_SAMPLE_BYTES = 8192

export function assertNotAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted) throw new FsError(`${operation} aborted`, 'FS_ABORTED')
}

export function mapError(error: unknown, operation: string, path: string, signal?: AbortSignal): FsError {
  if (error instanceof FsError) return error
  if (signal?.aborted || error instanceof DOMException && error.name === 'AbortError') {
    return new FsError(`${operation} aborted`, 'FS_ABORTED', { cause: error })
  }
  const text = error instanceof Error ? error.message : String(error)
  if (/not found|no such file|not a directory|404/i.test(text)) {
    return new FsError(`cannot ${operation} "${path}": not found`, 'FS_NOT_FOUND', { cause: error })
  }
  if (/permission denied|operation not permitted/i.test(text)) {
    return new FsError(`cannot ${operation} "${path}": permission denied`, 'FS_PERMISSION_DENIED', { cause: error })
  }
  return new FsError(`cannot ${operation} "${path}": ${text}`, 'FS_IO_ERROR', { cause: error })
}

/** Text reads refuse binary and invalid UTF-8 rather than returning mojibake. */
export function decodeText(bytes: Uint8Array, displayPath: string, sampleBytes = BINARY_SAMPLE_BYTES): string {
  if (bytes.subarray(0, sampleBytes).includes(0)) {
    throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
  }
}
