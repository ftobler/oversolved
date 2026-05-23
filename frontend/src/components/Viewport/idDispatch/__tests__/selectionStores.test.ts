import { describe, it, expect, beforeEach } from 'vitest'
import { hitToSelectionKey } from '../useIdBufferPointerDispatch'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import type { ResolvedHit } from '@/picking'

// The two selection stores (hover + normal) are fed from the same ground-truth
// resolve via the same key-derivation function, so they can never diverge about
// identity. See feature/selection-unification.md.

function hit(layer: string, entityKey: string): ResolvedHit {
  return { id: 1, layer, entityKey, distancePx: 0 }
}

beforeEach(() => {
  useSketchEditorStore.setState({ normalSelection: new Set(), hoveredSelectionId: null })
})

describe('hover/normal never diverge', () => {
  it('hitToSelectionKey returns the hit entityKey', () => {
    expect(hitToSelectionKey(hit('face', '@ex1/face/3'))).toBe('@ex1/face/3')
  })

  it('the key written to hover equals the key toggled into normal', () => {
    const h = hit('edge', '@ex1/edge/2')
    const key = hitToSelectionKey(h)

    // hover store
    useSketchEditorStore.getState().setHoveredSelectionId(key)
    // normal store, fed from the same key
    useSketchEditorStore.getState().toggleNormalSelection(key)

    const s = useSketchEditorStore.getState()
    expect(s.hoveredSelectionId).toBe(key)
    expect(s.normalSelection.has(s.hoveredSelectionId!)).toBe(true)
  })

  it('promoting the hovered key equals re-sampling the same hit', () => {
    const h = hit('plane', '@builtin_plane_top')
    // promote: toggle whatever hover holds
    useSketchEditorStore.getState().setHoveredSelectionId(hitToSelectionKey(h))
    useSketchEditorStore.getState().toggleNormalSelection(useSketchEditorStore.getState().hoveredSelectionId!)
    const promoted = new Set(useSketchEditorStore.getState().normalSelection)

    // resample: toggle off then toggle the freshly-derived key
    useSketchEditorStore.getState().toggleNormalSelection('@builtin_plane_top') // off
    useSketchEditorStore.getState().toggleNormalSelection(hitToSelectionKey(h)) // on
    const resampled = useSketchEditorStore.getState().normalSelection

    expect([...resampled]).toEqual([...promoted])
  })
})
