/** Single-quotes one POSIX argument so a value is never interpolated as syntax. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}
