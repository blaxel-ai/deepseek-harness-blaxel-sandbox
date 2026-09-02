/** The launch, as a list the operator can watch rather than a single spinner. */
import type { LaunchProgress, LaunchStep, Status } from './api.js'
import { formatBytes } from './format.js'

export const LAUNCH_STEPS: readonly LaunchStep[] = [
  'inspecting',
  'listing',
  'screening',
  'archiving',
  'session',
  'starting',
  'ready',
]

export interface LaunchLine {
  step: LaunchStep
  label: string
  detail?: string
  state: 'done' | 'active' | 'waiting'
}

function label(step: LaunchStep, kind: LaunchProgress['kind']): string {
  switch (step) {
    case 'inspecting': return 'Checking the Git worktree'
    case 'listing': return 'Finding workspace files'
    case 'screening': return 'Excluding sensitive files'
    case 'archiving': return 'Preparing the workspace snapshot'
    case 'session': return 'Preparing the session handoff'
    case 'starting': return 'Starting the Blaxel sandbox'
    case 'ready': return kind === 'move' ? 'Ready on Blaxel' : 'Ready on Blaxel'
  }
}

function detail(step: LaunchStep, progress: LaunchProgress): string | undefined {
  const files = progress.files
  if (step === 'screening' && files !== undefined && files.total > 0) {
    const skipped = files.skipped === 0 ? '' : `, ${String(files.skipped)} excluded`
    return `${String(files.screened)} of ${String(files.total)}${skipped}`
  }
  if (step === 'archiving' && files !== undefined && files.included > 0) {
    const size = progress.archiveBytes === undefined ? '' : ` · ${formatBytes(progress.archiveBytes)}`
    return `${String(Math.min(files.archived, files.included))} of ${String(files.included)} files${size}`
  }
  return undefined
}

/**
 * A move changes the active session's execution backend; opening a blank
 * worktree does not need that handoff step.
 */
export function launchLines(progress: LaunchProgress): LaunchLine[] {
  const steps = LAUNCH_STEPS.filter(step => step !== 'session' || progress.kind === 'move')
  const current = steps.indexOf(progress.step)
  return steps.map((step, index) => ({
    step,
    label: label(step, progress.kind),
    ...(index === current ? { detail: detail(step, progress) } : {}),
    state: index < current ? 'done' : index === current ? 'active' : 'waiting',
  }))
}

/** True while the host is doing launch work this window should be watching. */
export function launching(status: Status | undefined): boolean {
  return status?.progress !== undefined && status.progress.step !== 'ready'
}
