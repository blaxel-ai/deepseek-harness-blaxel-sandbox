/** Display helpers shared by the Blaxel status strip and settings panel. */

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  const units = ['KiB', 'MiB', 'GiB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : String(Math.round(value))} ${units[unit] ?? 'GiB'}`
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`
  const hours = Math.floor(minutes / 60)
  return `${String(hours)}h ${String(minutes % 60)}m`
}

export function shortCommit(commit: string | undefined): string | undefined {
  return commit === undefined ? undefined : commit.slice(0, 7)
}

/** How long ago an ISO timestamp was measured, for facts that go stale. */
export function formatAge(iso: string): string {
  const measured = Date.parse(iso)
  return Number.isFinite(measured) ? `${formatDuration(Date.now() - measured)} ago` : 'just now'
}
