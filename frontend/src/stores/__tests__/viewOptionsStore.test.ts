// The viewer options store: browser preference behind the preferences port,
// never document state. Its defaults are pinned to today's look so an upgrade
// cannot silently change the image, and its cross-field rules are pinned here
// because they are what keeps the viewport from drawing nothing.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { backendBundle } from '@/adapters/backend'
import { DEFAULT_PREFS, DEFAULT_VIEW_PREFERENCES, MAX_BRIGHTNESS, type UserPreferences } from '@/adapters/preferences'
import {
  useViewOptionsStore,
  normalizeAnalysis,
  normalizeLayers,
  syncViewOptionsFromPreferences,
  viewOptionsFromPreferences,
} from '@/stores/viewOptionsStore'

function reset(overrides: Partial<ReturnType<typeof useViewOptionsStore.getState>> = {}): void {
  useViewOptionsStore.setState({ ...DEFAULT_VIEW_PREFERENCES, collisionDebug: false, ...overrides })
}

describe('view options store', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
    reset()
  })

  it('defaults to exactly today\'s look', () => {
    const state = useViewOptionsStore.getState()
    expect(state.shading).toBe(true)
    expect(state.edges).toBe(true)
    expect(state.brightness).toBe(1)
    expect(state.zebra).toBe(false)
    expect(state.curvature).toBe(false)
    expect(state.orbit_around_cursor).toBe(true)
    expect(state.collisionDebug).toBe(false)
  })

  it('persists the orbit-around-cursor choice through the port', () => {
    const save = vi.spyOn(backendBundle.preferences, 'save').mockResolvedValue(undefined)
    useViewOptionsStore.getState().setOrbitAroundCursor(false)

    expect(useViewOptionsStore.getState().orbit_around_cursor).toBe(false)
    expect(save).toHaveBeenCalledTimes(1)
    const [next, key, value] = save.mock.calls[0]
    expect(key).toBe('view')
    expect((value as { orbit_around_cursor: boolean }).orbit_around_cursor).toBe(false)
    expect(next.view.orbit_around_cursor).toBe(false)
  })

  it('seeds from the port when boot calls sync, normalizing the record', () => {
    // main.tsx runs this before the first render. Zebra with shading off is an
    // illegal pair: the boot read must land on the nearest legal view.
    localStorage.setItem('oversolved.preferences', JSON.stringify({
      document_sort: 'alphabetical',
      view: { shading: false, edges: true, brightness: 1.5, zebra: true },
    }))
    syncViewOptionsFromPreferences()
    const state = useViewOptionsStore.getState()
    expect(state.shading).toBe(false)
    expect(state.edges).toBe(true)
    expect(state.brightness).toBe(1.5)
    expect(state.zebra).toBe(false)
  })

  it('persists a change through the preferences port', () => {
    const save = vi.spyOn(backendBundle.preferences, 'save').mockResolvedValue(undefined)
    useViewOptionsStore.getState().setEdges(false)

    expect(save).toHaveBeenCalledTimes(1)
    const [next, key, value] = save.mock.calls[0]
    expect(key).toBe('view')
    expect((value as { edges: boolean }).edges).toBe(false)
    expect(next.view.edges).toBe(false)
    expect(useViewOptionsStore.getState().edges).toBe(false)
  })

  it('never writes the collision debug flag to the preferences port', () => {
    const save = vi.spyOn(backendBundle.preferences, 'save').mockResolvedValue(undefined)
    useViewOptionsStore.getState().setCollisionDebug(true)

    expect(save).not.toHaveBeenCalled()
    expect(useViewOptionsStore.getState().collisionDebug).toBe(true)
    expect(JSON.stringify(backendBundle.preferences.read())).not.toContain('collision')
  })

  it('keeps the in-memory value when the write throws', () => {
    // The real adapter swallows the throw (site data disabled), so the only
    // observable is that the live value survived and no rejection escaped.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('SecurityError') })
    expect(() => useViewOptionsStore.getState().setBrightness(1.7)).not.toThrow()
    expect(useViewOptionsStore.getState().brightness).toBe(1.7)
  })

  it('clamps brightness to the range and resets to 1', () => {
    useViewOptionsStore.getState().setBrightness(9)
    expect(useViewOptionsStore.getState().brightness).toBe(2)
    useViewOptionsStore.getState().setBrightness(Number.NaN)
    expect(useViewOptionsStore.getState().brightness).toBe(1)
    useViewOptionsStore.getState().setBrightness(0.8)
    useViewOptionsStore.getState().resetBrightness()
    expect(useViewOptionsStore.getState().brightness).toBe(1)
  })

  it('refuses to leave both drawn layers off', () => {
    reset({ shading: true, edges: true })
    useViewOptionsStore.getState().setEdges(false)
    expect(useViewOptionsStore.getState().edges).toBe(false)
    // The last layer on cannot be turned off.
    useViewOptionsStore.getState().setShading(false)
    expect(useViewOptionsStore.getState().shading).toBe(false)
    expect(useViewOptionsStore.getState().edges).toBe(true)

    reset({ shading: true, edges: false })
    useViewOptionsStore.getState().setEdges(false)
    expect(useViewOptionsStore.getState().edges).toBe(false)
    expect(useViewOptionsStore.getState().shading).toBe(true)
  })

  it('says which layer wins when both are asked off', () => {
    expect(normalizeLayers(true, true)).toEqual({ shading: true, edges: true })
    expect(normalizeLayers(false, false)).toEqual({ shading: false, edges: true })
    expect(normalizeLayers(true, false)).toEqual({ shading: true, edges: false })
  })

  it('keeps zebra and curvature exclusive, the one just turned on winning', () => {
    reset({ shading: true, zebra: false, curvature: false })
    useViewOptionsStore.getState().setZebra(true)
    expect(useViewOptionsStore.getState().zebra).toBe(true)
    useViewOptionsStore.getState().setCurvature(true)
    expect(useViewOptionsStore.getState().curvature).toBe(true)
    expect(useViewOptionsStore.getState().zebra).toBe(false)
    useViewOptionsStore.getState().setZebra(true)
    expect(useViewOptionsStore.getState().zebra).toBe(true)
    expect(useViewOptionsStore.getState().curvature).toBe(false)

    expect(normalizeAnalysis(true, true, 'curvature')).toEqual({ zebra: false, curvature: true })
    expect(normalizeAnalysis(true, true, 'zebra')).toEqual({ zebra: true, curvature: false })
  })

  it('cannot arm an analysis material while shading is off', () => {
    reset({ shading: false, edges: true })
    useViewOptionsStore.getState().setZebra(true)
    expect(useViewOptionsStore.getState().zebra).toBe(false)
    useViewOptionsStore.getState().setCurvature(true)
    expect(useViewOptionsStore.getState().curvature).toBe(false)
  })

  it('turns the analysis materials off with the faces they need', () => {
    reset({ shading: true, edges: true, zebra: true })
    useViewOptionsStore.getState().setShading(false)
    expect(useViewOptionsStore.getState().zebra).toBe(false)
    expect(useViewOptionsStore.getState().shading).toBe(false)
    expect(useViewOptionsStore.getState().edges).toBe(true)
  })

  it('clamps the stripe count', () => {
    useViewOptionsStore.getState().setZebraStripes(1)
    expect(useViewOptionsStore.getState().zebra_stripes).toBe(2)
    useViewOptionsStore.getState().setZebraStripes(200)
    expect(useViewOptionsStore.getState().zebra_stripes).toBe(40)
    useViewOptionsStore.getState().setZebraStripes(Number.NaN)
    expect(useViewOptionsStore.getState().zebra_stripes).toBe(DEFAULT_VIEW_PREFERENCES.zebra_stripes)
  })

  it('normalizes a raw record itself, not only through the adapter', () => {
    const raw: UserPreferences = {
      ...DEFAULT_PREFS,
      view: {
        ...DEFAULT_VIEW_PREFERENCES,
        shading: false,
        edges: false,
        zebra: true,
        curvature: true,
        brightness: 99,
        curvature_range: [2, 1],
      },
    }
    const view = viewOptionsFromPreferences(raw)
    // Both layers off is illegal: edges win.
    expect(view.shading).toBe(false)
    expect(view.edges).toBe(true)
    // Analysis needs the faces, so shading off clears both.
    expect(view.zebra).toBe(false)
    expect(view.curvature).toBe(false)
    expect(view.brightness).toBe(MAX_BRIGHTNESS)
    // An inverted range is not a range.
    expect(view.curvature_range).toBeNull()
  })

  it('refuses an inverted or non-finite curvature range instead of storing it', () => {
    reset({ curvature_range: [0, 1] })
    useViewOptionsStore.getState().setCurvatureRange([2, 1])
    expect(useViewOptionsStore.getState().curvature_range).toEqual([0, 1])
    useViewOptionsStore.getState().setCurvatureRange([0, Number.NaN])
    expect(useViewOptionsStore.getState().curvature_range).toEqual([0, 1])
    useViewOptionsStore.getState().setCurvatureRange(null)
    expect(useViewOptionsStore.getState().curvature_range).toBeNull()
  })
})
