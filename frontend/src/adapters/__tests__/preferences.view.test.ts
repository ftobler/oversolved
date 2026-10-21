// The viewer options travel in the same localStorage record as the documents
// sort. A stored value is untrusted, and a single stale field must not reset
// the rest of the view, so every field is checked on its own here.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DEFAULT_VIEW_PREFERENCES, readLocalPrefs } from '@/adapters/preferences'

const KEY = 'oversolved.preferences'

function store(prefs: unknown): void {
  localStorage.setItem(KEY, JSON.stringify(prefs))
}

describe('viewer options in the preferences record', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('fills the view defaults when the key is missing', () => {
    expect(readLocalPrefs().view).toEqual(DEFAULT_VIEW_PREFERENCES)
  })

  it('fills the view defaults when the record is malformed', () => {
    localStorage.setItem(KEY, '{not json')
    expect(readLocalPrefs().view).toEqual(DEFAULT_VIEW_PREFERENCES)
    localStorage.setItem(KEY, '5')
    expect(readLocalPrefs().view).toEqual(DEFAULT_VIEW_PREFERENCES)
  })

  it('fills the view defaults when the record predates the view object', () => {
    store({ document_sort: 'alphabetical' })
    const prefs = readLocalPrefs()
    expect(prefs.document_sort).toBe('alphabetical')
    expect(prefs.view).toEqual(DEFAULT_VIEW_PREFERENCES)
  })

  it('keeps the valid fields when one view field is bad', () => {
    store({
      document_sort: 'alphabetical',
      view: { shading: false, edges: true, brightness: 1.5, zebra_stripes: 'lots' },
    })
    const view = readLocalPrefs().view
    expect(view.shading).toBe(false)
    expect(view.edges).toBe(true)
    expect(view.brightness).toBe(1.5)
    expect(view.zebra_stripes).toBe(DEFAULT_VIEW_PREFERENCES.zebra_stripes)
  })

  it('clamps a brightness outside the range and falls back on garbage', () => {
    store({ view: { brightness: 9 } })
    expect(readLocalPrefs().view.brightness).toBe(2)
    store({ view: { brightness: -3 } })
    expect(readLocalPrefs().view.brightness).toBe(0.5)
    store({ view: { brightness: 'bright' } })
    expect(readLocalPrefs().view.brightness).toBe(1)
    store({ view: { brightness: Number.NaN } })
    // JSON cannot carry NaN; the record is written as null, which is not finite.
    expect(readLocalPrefs().view.brightness).toBe(1)
  })

  it('defaults the analysis options off', () => {
    const view = readLocalPrefs().view
    expect(view.zebra).toBe(false)
    expect(view.curvature).toBe(false)
    expect(view.curvature_kind).toBe('mean')
    expect(view.curvature_range).toBeNull()
  })

  it('rejects a curvature kind outside the union and a nonsense range', () => {
    store({ view: { curvature_kind: 'principal', curvature_range: [2, 2] } })
    expect(readLocalPrefs().view.curvature_kind).toBe('mean')
    expect(readLocalPrefs().view.curvature_range).toBeNull()
    store({ view: { curvature_range: [1, 4] } })
    expect(readLocalPrefs().view.curvature_range).toEqual([1, 4])
  })

  it('never leaves both drawn layers off', () => {
    store({ view: { shading: false, edges: false } })
    const view = readLocalPrefs().view
    expect(view.shading || view.edges).toBe(true)
  })

  it('turns the analysis materials off when shading is off', () => {
    store({ view: { shading: false, edges: true, zebra: true, curvature: true } })
    const view = readLocalPrefs().view
    expect(view.zebra).toBe(false)
    expect(view.curvature).toBe(false)
  })

  it('keeps at most one analysis material on', () => {
    store({ view: { zebra: true, curvature: true } })
    const view = readLocalPrefs().view
    expect(view.zebra && view.curvature).toBe(false)
  })
})
