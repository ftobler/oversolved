import { describe, it, expect, beforeEach } from 'vitest'
import { useSketchEditorStore, setSketchCallback } from '@/stores/sketchEditorStore'

beforeEach(() => {
  setSketchCallback('onMutation', null)
  setSketchCallback('onRebuild', null)
  setSketchCallback('onExitSketch', null)
  useSketchEditorStore.setState({
    normalSelection: new Set(['@builtin_plane_top']),
    hovered3DSurfaceId: null,
  })
  // Push 'plane_selection' mode so commitPlaneSelection can pop it
  useSketchEditorStore.getState().setPlaneSelectionFeatureId('sk1')
})

describe('_sketchCbs guard throws in test mode when callback is unregistered', () => {
  it('commitPlaneSelection throws when onMutation is not registered', () => {
    expect(() => {
      useSketchEditorStore.getState().commitPlaneSelection('@builtin_plane_top')
    }).toThrow('callback not registered')
  })

  it('does not throw after registering the callback', () => {
    setSketchCallback('onMutation', () => {})
    expect(() => {
      useSketchEditorStore.getState().commitPlaneSelection('@builtin_plane_top')
    }).not.toThrow()
  })
})
