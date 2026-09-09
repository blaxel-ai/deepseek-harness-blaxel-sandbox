import { describe, expect, it } from 'vitest'
import type { ClientSessionListState } from '../src/client/context.js'
import { sandboxRowTitles, SIDEBAR_MARKER_CSS } from '../src/client/BlaxelSidebarMarker.js'

describe('sandbox sidebar marker', () => {
  it('renders through the native leading icon slot', () => {
    expect(SIDEBAR_MARKER_CSS).toContain('[data-blaxel-sandbox-session] > span:first-child')
    expect(SIDEBAR_MARKER_CSS).toContain('[data-blaxel-sandbox-session="failed"] > span:first-child')
    expect(SIDEBAR_MARKER_CSS).not.toContain(']::before')
  })

  it('keeps native titles and marks uniquely identifiable sandbox rows', () => {
    const state: ClientSessionListState = {
      ids: ['sandbox', 'local'],
      current: 'sandbox',
      byId: {
        sandbox: { blank: false, displayTitle: 'Inspect remote execution' },
        local: { blank: false, displayTitle: 'Local work' },
      },
    }
    expect(sandboxRowTitles(state, ['sandbox'])).toEqual(['Inspect remote execution'])
  })

  it('finds an untitled binding through the row display title DSH derives', () => {
    const state: ClientSessionListState = {
      ids: ['sandbox', 'other'],
      current: 'other',
      byId: {
        sandbox: { blank: false, displayTitle: 'calibrator' },
        other: { blank: false, displayTitle: 'We need a small UX' },
      },
    }
    expect(sandboxRowTitles(state, ['sandbox'])).toEqual(['calibrator'])
  })

  it('marks only the selected duplicate title', () => {
    const state: ClientSessionListState = {
      ids: ['sandbox', 'local'],
      current: 'local',
      byId: {
        sandbox: { blank: false, displayTitle: 'Same title' },
        local: { blank: false, displayTitle: 'Same title' },
      },
    }
    expect(sandboxRowTitles(state, ['sandbox'])).toEqual([])
  })
})
