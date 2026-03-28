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

// 1f / 4m: clicking a builtin in normal mode only selects, no set_feature_plane
describe('builtin click in normal mode (planeSelectionFeatureId=null)', () => {
  beforeEach(() => {
    useSketchEditorStore.getState().clearSelection()
    useSketchEditorStore.setState({ planeSelectionFeatureId: null })
  })

  it('toggleSelect emits no mutation when onMutation is null (normal mode)', () => {
    // In normal mode, planeSelectionFeatureId is null.
    // The store's toggleSelect only updates selection, never emits mutations itself.
    const state = useSketchEditorStore.getState()
    expect(state.onMutation).toBeNull()
    expect(() => state.toggleSelect('@builtin_plane_front')).not.toThrow()
  })

  it('adds builtin to selection and emits no set_feature_plane mutation', () => {
    const mutations: unknown[] = []
    useSketchEditorStore.getState().setOnMutation(m => mutations.push(m))
    useSketchEditorStore.getState().toggleSelect('@builtin_plane_top')
    expect(useSketchEditorStore.getState().selection.has('@builtin_plane_top')).toBe(true)
    expect(mutations).toHaveLength(0)
  })

  it('commitPlaneSelection is no-op when planeSelectionFeatureId is null', () => {
    const mutations: unknown[] = []
    useSketchEditorStore.getState().setOnMutation(m => mutations.push(m))
    useSketchEditorStore.getState().commitPlaneSelection('@builtin_plane_top')
    expect(mutations).toHaveLength(0)
  })
})
