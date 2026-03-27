import { describe, it, expect, beforeEach } from 'vitest'
import { builtinSelectionId } from '../Geometry3D/utils'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'

// 1a: builtinSelectionId helper
describe('builtinSelectionId', () => {
  it('returns @builtin_plane_front for Front', () => {
    expect(builtinSelectionId('Front')).toBe('@builtin_plane_front')
  })
  it('returns @builtin_plane_top for Top', () => {
    expect(builtinSelectionId('Top')).toBe('@builtin_plane_top')
  })
  it('returns @builtin_plane_right for Right', () => {
    expect(builtinSelectionId('Right')).toBe('@builtin_plane_right')
  })
  it('returns @builtin_origin for Origin', () => {
    expect(builtinSelectionId('Origin')).toBe('@builtin_origin')
  })
})

// 1b: store toggleSelect accepts @-prefixed IDs
describe('store toggleSelect with @-prefixed IDs', () => {
  beforeEach(() => {
    useSketchEditorStore.getState().clearSelection()
  })

  it('adds @builtin_plane_front to selection on first call', () => {
    useSketchEditorStore.getState().toggleSelect('@builtin_plane_front')
    expect(useSketchEditorStore.getState().selection.has('@builtin_plane_front')).toBe(true)
  })

  it('removes @builtin_plane_front from selection on second call', () => {
    useSketchEditorStore.getState().toggleSelect('@builtin_plane_front')
    useSketchEditorStore.getState().toggleSelect('@builtin_plane_front')
    expect(useSketchEditorStore.getState().selection.has('@builtin_plane_front')).toBe(false)
  })
})

// 1f: clicking a builtin in normal mode (planeSelectionFeatureId=null) does NOT emit set_feature_plane
describe('builtin click does not emit set_feature_plane when not in plane-selection mode', () => {
  it('toggleSelect emits no mutation when onMutation is null (normal mode)', () => {
    // In normal mode, planeSelectionFeatureId is null (Step 4 state).
    // The store's toggleSelect only updates selection, never emits mutations itself.
    const state = useSketchEditorStore.getState()
    // Verify onMutation is null by default (no plane-selection mode active)
    expect(state.onMutation).toBeNull()
    // Calling toggleSelect should not throw and should not emit any mutation
    expect(() => state.toggleSelect('@builtin_plane_front')).not.toThrow()
  })
})
