import { describe, expect, it } from 'vitest'
import type { LaunchProgress } from '../src/client/api.js'
import { launching, launchLines } from '../src/client/launch-steps.js'
import { LaunchTracker } from '../src/web/launch-progress.js'

describe('launch progress tracking', () => {
  it('reports nothing until a launch begins, and nothing again once it is cleared', () => {
    const tracker = new LaunchTracker()
    expect(tracker.snapshot()).toBeUndefined()
    tracker.report({ step: 'screening', total: 10 })
    expect(tracker.snapshot()).toBeUndefined()
    tracker.begin('open')
    expect(tracker.snapshot()).toMatchObject({ kind: 'open', step: 'inspecting' })
    tracker.clear()
    expect(tracker.snapshot()).toBeUndefined()
  })

  it('carries counts forward across events that only report one of them', () => {
    const tracker = new LaunchTracker()
    tracker.begin('move')
    tracker.report({ step: 'screening', total: 400, screened: 128, included: 120, skipped: 8 })
    tracker.report({ step: 'archiving', archived: 30 })
    expect(tracker.snapshot()).toMatchObject({
      step: 'archiving',
      files: { screened: 128, total: 400, included: 120, skipped: 8, archived: 30 },
    })
    tracker.report({ step: 'archiving', archived: 120, archiveBytes: 2048 })
    tracker.step('starting')
    expect(tracker.snapshot()).toMatchObject({ step: 'starting', archiveBytes: 2048 })
  })
})

describe('launch step list', () => {
  const progress = (patch: Partial<LaunchProgress>): LaunchProgress => ({
    kind: 'open',
    step: 'inspecting',
    startedAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    ...patch,
  })

  it('shows the handoff only when moving an existing session', () => {
    expect(launchLines(progress({})).map(line => line.step)).not.toContain('session')
    expect(launchLines(progress({ kind: 'move' })).map(line => line.step)).toContain('session')
  })

  it('marks earlier steps done and later steps waiting', () => {
    const lines = launchLines(progress({ step: 'archiving' }))
    expect(lines.find(line => line.step === 'listing')?.state).toBe('done')
    expect(lines.find(line => line.step === 'archiving')?.state).toBe('active')
    expect(lines.find(line => line.step === 'starting')?.state).toBe('waiting')
  })

  it('counts real files on the step in flight and nowhere else', () => {
    const files = { screened: 128, total: 400, included: 120, skipped: 8, archived: 40 }
    const screening = launchLines(progress({ step: 'screening', files }))
    expect(screening.find(line => line.step === 'screening')?.detail).toBe('128 of 400, 8 withheld')
    const archiving = launchLines(progress({ step: 'archiving', files, archiveBytes: 4096 }))
    expect(archiving.find(line => line.step === 'archiving')?.detail).toBe('40 of 120 files · 4.0 KiB')
    expect(archiving.find(line => line.step === 'screening')?.detail).toBeUndefined()
  })

  it('knows when the local window has launch work to watch', () => {
    const status = (progress?: LaunchProgress): Parameters<typeof launching>[0] =>
      ({
        ok: true,
        sandboxes: [],
        settings: {
          connection: { authenticated: false, source: 'none', environment: 'production', profiles: [], managedByEnvironment: false },
          defaults: { image: 'blaxel/node:latest', memory: 4096 },
          choices: {
            images: [{ value: 'blaxel/node:latest', label: 'Node' }],
            memory: [4096],
            regions: [{ value: '', label: 'Automatic' }],
            idleDeletion: [{ value: '', label: 'Platform default' }],
            verified: false,
          },
          capabilities: {
            skills: { installed: false, names: [] },
            mcp: { connected: false, endpoint: 'https://api.blaxel.ai/v0/mcp' },
          },
        },
        ...(progress === undefined ? {} : { progress }),
      })
    expect(launching(undefined)).toBe(false)
    expect(launching(status())).toBe(false)
    expect(launching(status(progress({ step: 'archiving' })))).toBe(true)
    expect(launching(status(progress({ step: 'ready' })))).toBe(false)
  })
})
