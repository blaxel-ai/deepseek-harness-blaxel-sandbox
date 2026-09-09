/** One bridge poll shared by every Blaxel surface in the window. */
import { useEffect, useState } from 'react'
import { getStatus, type Status } from './api.js'
import { launching } from './launch-steps.js'

const IDLE_MS = 2_000
/** While work is in flight the readout is a progress bar, so it must feel live. */
const BUSY_MS = 400

let latest: Status | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let inFlight = false
const listeners = new Set<(status: Status | undefined) => void>()

function interval(status: Status | undefined): number {
  if (launching(status)) return BUSY_MS
  return IDLE_MS
}

/** One read at a time, and exactly one pending timer, however it was triggered. */
async function read(): Promise<void> {
  if (inFlight) return
  inFlight = true
  if (timer !== undefined) clearTimeout(timer)
  timer = undefined
  try {
    const next = await getStatus().catch(() => undefined)
    if (next !== undefined) {
      latest = next
      for (const listener of listeners) listener(next)
    }
    if (listeners.size > 0) timer = setTimeout(() => { void read() }, interval(next ?? latest))
  } finally {
    inFlight = false
  }
}

/** Pulls the status now, so an action does not wait out the current interval. */
export function refreshBlaxelStatus(): void {
  void read()
}

export function useBlaxelStatus(): Status | undefined {
  const [status, setStatus] = useState<Status | undefined>(latest)
  useEffect(() => {
    const first = listeners.size === 0
    listeners.add(setStatus)
    if (first) void read()
    return () => {
      listeners.delete(setStatus)
      if (listeners.size > 0 || timer === undefined) return
      clearTimeout(timer)
      timer = undefined
    }
  }, [])
  return status
}
