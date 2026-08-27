/**
 * Live account of one sandbox launch. The local window polls it while it
 * waits, so a launch is never a blank tab and a spinner: every step the host
 * actually performs is named, and the file counts are the real ones.
 */

export type LaunchStep =
  | 'inspecting'
  | 'listing'
  | 'screening'
  | 'archiving'
  | 'session'
  | 'starting'
  | 'ready'

export interface LaunchFiles {
  /** Worktree entries examined so far. */
  screened: number
  /** Entries `git ls-files` reported for this worktree. */
  total: number
  /** Entries accepted into the snapshot. */
  included: number
  /** Entries withheld because they look like credentials or private state. */
  skipped: number
  /** Entries written into the archive so far. */
  archived: number
}

export interface LaunchProgress {
  kind: 'open' | 'move'
  step: LaunchStep
  files?: LaunchFiles
  archiveBytes?: number
  startedAt: string
  updatedAt: string
  /** Why the launch stopped. The step it stopped on is left as it was. */
  error?: string
}

/** What the snapshot builder tells the tracker as it works. */
export interface SnapshotProgress {
  step: 'listing' | 'screening' | 'archiving'
  total?: number
  screened?: number
  included?: number
  skipped?: number
  archived?: number
  archiveBytes?: number
}

export type ProgressReport = (event: SnapshotProgress) => void

const EMPTY_FILES: LaunchFiles = { screened: 0, total: 0, included: 0, skipped: 0, archived: 0 }

export class LaunchTracker {
  private state: LaunchProgress | undefined

  begin(kind: 'open' | 'move'): void {
    const now = new Date().toISOString()
    this.state = { kind, step: 'inspecting', startedAt: now, updatedAt: now }
  }

  step(step: LaunchStep): void {
    if (this.state === undefined) return
    this.state = { ...this.state, step, updatedAt: new Date().toISOString() }
  }

  /** Merges one snapshot event; counts only ever move forward within a launch. */
  readonly report: ProgressReport = (event) => {
    const current = this.state
    if (current === undefined) return
    const files = current.files ?? EMPTY_FILES
    this.state = {
      ...current,
      step: event.step,
      updatedAt: new Date().toISOString(),
      files: {
        screened: event.screened ?? files.screened,
        total: event.total ?? files.total,
        included: event.included ?? files.included,
        skipped: event.skipped ?? files.skipped,
        archived: event.archived ?? files.archived,
      },
      ...(event.archiveBytes === undefined ? {} : { archiveBytes: event.archiveBytes }),
    }
  }

  /**
   * A failure is kept, not dropped: the launch page and the composer panel are
   * the only places the reason is ever shown, and both read it from here.
   */
  fail(error: string): void {
    if (this.state === undefined) return
    this.state = { ...this.state, error, updatedAt: new Date().toISOString() }
  }

  clear(): void {
    this.state = undefined
  }

  snapshot(): LaunchProgress | undefined {
    return this.state
  }
}
