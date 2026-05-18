import { describe, it, expect, beforeEach } from 'vitest'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { planeAdapter, clearPlaneHover } from '../planeAdapter'

beforeEach(() => {
  useSketchEditorStore.setState({
    hoveredPlaneId: null,
    normalSelection: new Set(),
    planeSelectionFeatureId: null,
  })
})

describe('planeAdapter', () => {
  it('onHover sets hoveredPlaneId', () => {
    planeAdapter.onHover('@builtin_plane_top')
    expect(useSketchEditorStore.getState().hoveredPlaneId).toBe('@builtin_plane_top')
  })

  it('clearPlaneHover clears hoveredPlaneId', () => {
    planeAdapter.onHover('@builtin_plane_front')
    clearPlaneHover()
    expect(useSketchEditorStore.getState().hoveredPlaneId).toBeNull()
  })

  it('onClick toggles normalSelection', () => {
    planeAdapter.onClick('@plane1')
    expect(useSketchEditorStore.getState().normalSelection.has('@plane1')).toBe(true)
  })
})
