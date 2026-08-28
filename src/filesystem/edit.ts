/** Line-ending policy and the literal edit DSH asks the filesystem to apply. */
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsEditRequest } from '@deepseek-ai/dsh-fs'

export function normalizeLineEndings(value: string): string {
  return value.replaceAll('\r\n', '\n')
}

export function detectsCrlf(value: string): boolean {
  const sample = value.slice(0, 4096)
  const crlf = sample.split('\r\n').length - 1
  return crlf > sample.split('\n').length - 1 - crlf
}

export function restoreLineEndings(value: string, crlf: boolean): string {
  return crlf ? normalizeLineEndings(value).replaceAll('\n', '\r\n') : value
}

export function literalEdit(content: string, request: FsEditRequest, displayPath: string): string {
  const oldString = normalizeLineEndings(request.oldString)
  const newString = normalizeLineEndings(request.newString)
  if (oldString.length === 0) throw new FsError(`cannot edit "${displayPath}": old_string must be non-empty`, 'FS_EDIT_NOT_FOUND')
  const pieces = content.split(oldString)
  if (pieces.length === 1) throw new FsError(`cannot edit "${displayPath}": old_string was not found`, 'FS_EDIT_NOT_FOUND')
  if (!request.replaceAll && pieces.length !== 2) {
    throw new FsError(`cannot edit "${displayPath}": old_string matched ${String(pieces.length - 1)} times`, 'FS_AMBIGUOUS_EDIT')
  }
  return request.replaceAll ? pieces.join(newString) : `${pieces[0]}${newString}${pieces[1]}`
}
