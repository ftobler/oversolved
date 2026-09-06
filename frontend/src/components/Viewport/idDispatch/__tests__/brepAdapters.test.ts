// L6: hover must mirror the click router's rule for the paired identity fields.
// The click router writes `hit.pickKey === key ? undefined : hit.pickKey`, so a
// plane / origin / sketch-surface / feature-handle hit (pickKey IS the query)
// records no per-primitive claim. `setSelectionIdOnHover` used to store the
// query verbatim as `hoveredPickKey`; now it applies the same guard, so hover
// and click produce identical ActiveHighlight shapes for the same hit.
import { describe, it, expect, beforeEach } from 'vitest'
import { setSelectionIdOnHover } from '@/components/Viewport/idDispatch/brepAdapters'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { hoverActiveFrom, EMPTY_CLAIM_MAP } from '@/picking/highlightActive'

beforeEach(() => {
  useSketchEditorStore.setState({ hoveredSelectionId: null, hoveredPickKey: null } as never)
})

describe('setSelectionIdOnHover pickKey guard', () => {
  it('an edge hover stores its per-primitive pickKey', () => {
    setSelectionIdOnHover('?edge_q', 'ex1/body_ex1#edge#3')
    expect(useSketchEditorStore.getState().hoveredPickKey).toBe('ex1/body_ex1#edge#3')
  })

  it('a plane / sketch-surface hover where pickKey equals the query stores no pickKey', () => {
    setSelectionIdOnHover('@builtin_plane_xy', '@builtin_plane_xy')
    expect(useSketchEditorStore.getState().hoveredPickKey).toBeNull()
    expect(useSketchEditorStore.getState().hoveredSelectionId).toBe('@builtin_plane_xy')
  })

  it('a hover with no pickKey stores null', () => {
    setSelectionIdOnHover('@builtin_plane_xy')
    expect(useSketchEditorStore.getState().hoveredPickKey).toBeNull()
  })

  it('mirrors the click router rule for a hit whose pickKey is its query', () => {
    setSelectionIdOnHover('@builtin_plane_xy', '@builtin_plane_xy')
    const s = useSketchEditorStore.getState()
    expect(hoverActiveFrom(s.hoveredPickKey, s.hoveredSelectionId).pickKeys).toBe(EMPTY_CLAIM_MAP)
  })
})
