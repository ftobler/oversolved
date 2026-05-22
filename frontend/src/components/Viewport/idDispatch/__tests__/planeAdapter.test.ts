import { describe, it, expect, beforeEach } from 'vitest'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { planeAdapter } from '../planeAdapter'

beforeEach(() => {
  useSketchEditorStore.setState({
    hoveredSelectionId: null,
    normalSelection: new Set(),
    planeSelectionFeatureId: null,
  })
})

describe('planeAdapter', () => {
  it('onHover sets hoveredSelectionId', () => {
    planeAdapter.onHover('@builtin_plane_top')
    expect(useSketchEditorStore.getState().hoveredSelectionId).toBe('@builtin_plane_top')
  })

  it('setHoveredSelectionId(null) clears hoveredSelectionId', () => {
    planeAdapter.onHover('@builtin_plane_front')
    useSketchEditorStore.getState().setHoveredSelectionId(null)
    expect(useSketchEditorStore.getState().hoveredSelectionId).toBeNull()
  })

  it('onClick toggles normalSelection', () => {
    planeAdapter.onClick('@plane1')
    expect(useSketchEditorStore.getState().normalSelection.has('@plane1')).toBe(true)
  })
})
