import { describe, it, expect, beforeEach } from 'vitest'
import { builtinSelectionId } from '@/components/Geometry3D/utils'
import { useSketchEditorStore, setSketchCallback } from '@/stores/sketchEditorStore'

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

describe('store toggleNormalSelection with @-prefixed IDs', () => {
  beforeEach(() => {
    useSketchEditorStore.getState().clearNormalSelection()
  })

  it('adds @builtin_plane_front to selection on first call', () => {
    useSketchEditorStore.getState().toggleNormalSelection('@builtin_plane_front')
    expect(useSketchEditorStore.getState().normalSelection.has('@builtin_plane_front')).toBe(true)
  })

  it('toggles @-prefixed IDs on and off', () => {
    useSketchEditorStore.getState().toggleNormalSelection('@builtin_plane_top')
    expect(useSketchEditorStore.getState().normalSelection.has('@builtin_plane_top')).toBe(true)
    useSketchEditorStore.getState().toggleNormalSelection('@builtin_plane_top')
    expect(useSketchEditorStore.getState().normalSelection.has('@builtin_plane_top')).toBe(false)
  })

  it('adds entity and constraint IDs to selection', () => {
    useSketchEditorStore.getState().toggleNormalSelection('entity:sketch1:line1')
    useSketchEditorStore.getState().toggleNormalSelection('constraint:sketch1:coincident1')
    const sel = useSketchEditorStore.getState().normalSelection
    expect(sel.has('entity:sketch1:line1')).toBe(true)
    expect(sel.has('constraint:sketch1:coincident1')).toBe(true)
  })

  it('clearNormalSelection removes feature selections', () => {
    useSketchEditorStore.getState().toggleNormalSelection('@sketch1')
    useSketchEditorStore.getState().clearNormalSelection()
    expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
  })
})

describe('builtin click in normal mode (activePickField=null)', () => {
  beforeEach(() => {
    useSketchEditorStore.getState().clearNormalSelection()
    useSketchEditorStore.setState({ activePickField: null, modeStack: [] })
  })

  it('toggleNormalSelection emits no mutation when onMutation is null (normal mode)', () => {
    const state = useSketchEditorStore.getState()
    // onMutation is stored outside the Zustand state; verify no throw with no callback set
    expect(() => state.toggleNormalSelection('@builtin_plane_front')).not.toThrow()
  })

  it('adds builtin to selection and emits no set_feature_plane mutation', () => {
    const mutations: unknown[] = []
    setSketchCallback('onMutation', m => mutations.push(m))
    useSketchEditorStore.getState().toggleNormalSelection('@builtin_plane_top')
    expect(useSketchEditorStore.getState().normalSelection.has('@builtin_plane_top')).toBe(true)
    expect(mutations).toHaveLength(0)
  })

})
