import { describe, it, expect, beforeEach } from 'vitest'
import { useSketchEditorStore, setSketchCallback } from '@/stores/sketchEditorStore'

beforeEach(() => {
  setSketchCallback('onMutation', null)
  setSketchCallback('onRebuild', null)
  setSketchCallback('onExitSketch', null)
  useSketchEditorStore.setState({
    pendingPickField: { featureId: 'f1', field: 'plane' },
    normalSelection: new Set(['@builtin_plane_top']),
    planeSelectionFeatureId: 'sk1',
    hovered3DSurfaceId: null,
  })
})

describe('_sketchCbs guard throws in test mode when callback is unregistered', () => {
  it('commitFieldPick throws when onMutation is not registered', () => {
    expect(() => {
      useSketchEditorStore.getState().commitFieldPick()
    }).toThrow('callback not registered')
  })

  it('commitPlaneSelection throws when onMutation is not registered', () => {
    expect(() => {
      useSketchEditorStore.getState().commitPlaneSelection('@builtin_plane_top')
    }).toThrow('callback not registered')
  })

  it('does not throw after registering the callback', () => {
    const mutations: unknown[] = []
    setSketchCallback('onMutation', m => mutations.push(m))
    expect(() => {
      useSketchEditorStore.getState().commitFieldPick()
    }).not.toThrow()
    expect(mutations).toHaveLength(1)
  })
})
