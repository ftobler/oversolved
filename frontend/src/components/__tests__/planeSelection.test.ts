import { describe, it, expect, beforeEach } from 'vitest'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'
import { registerCommand, executeCommand, unregisterCommand, clearAllHandlers } from '../../stores/commandRegistry'

// Ensure clean state before each test
beforeEach(() => { clearAllHandlers() })

function reset() {
  useSketchEditorStore.setState({
    selection: new Set(),
    onMutation: null,
    planeSelectionFeatureId: null,
  })
}

// 4a: initial state
describe('planeSelectionFeatureId initial state', () => {
  it('is null by default', () => {
    reset()
    expect(useSketchEditorStore.getState().planeSelectionFeatureId).toBeNull()
  })
})

// 4b: setPlaneSelectionFeatureId
describe('setPlaneSelectionFeatureId', () => {
  beforeEach(reset)

  it('sets the featureId', () => {
    useSketchEditorStore.getState().setPlaneSelectionFeatureId('sketch1')
    expect(useSketchEditorStore.getState().planeSelectionFeatureId).toBe('sketch1')
  })

  it('clears with null', () => {
    useSketchEditorStore.getState().setPlaneSelectionFeatureId('sketch1')
    useSketchEditorStore.getState().setPlaneSelectionFeatureId(null)
    expect(useSketchEditorStore.getState().planeSelectionFeatureId).toBeNull()
  })
})

// 4c: commitPlaneSelection dispatches set_feature_plane for builtin IDs
describe('commitPlaneSelection with builtin ID', () => {
  beforeEach(reset)

  it('dispatches set_feature_plane and exits mode', () => {
    const mutations: unknown[] = []
    useSketchEditorStore.getState().setOnMutation(m => mutations.push(m))
    useSketchEditorStore.getState().setPlaneSelectionFeatureId('sketch1')
    useSketchEditorStore.getState().commitPlaneSelection('@builtin_plane_top')
    expect(mutations[0]).toEqual({ type: 'set_feature_plane', featureId: 'sketch1', plane: '@builtin_plane_top' })
    expect(useSketchEditorStore.getState().planeSelectionFeatureId).toBeNull()
  })
})

// 4d: commitPlaneSelection strips face: prefix
describe('commitPlaneSelection with face ID', () => {
  beforeEach(reset)

  it('strips face:<featureId>: prefix to get query', () => {
    const mutations: { plane?: string }[] = []
    useSketchEditorStore.getState().setOnMutation(m => mutations.push(m as { plane?: string }))
    useSketchEditorStore.getState().setPlaneSelectionFeatureId('sketch1')
    useSketchEditorStore.getState().commitPlaneSelection('face:sketch0:?3;@sketch0abc')
    expect(mutations[0].plane).toBe('?3;@sketch0abc')
  })

  it('preserves colons inside the query (type restriction suffix)', () => {
    const mutations: { plane?: string }[] = []
    useSketchEditorStore.getState().setOnMutation(m => mutations.push(m as { plane?: string }))
    useSketchEditorStore.getState().setPlaneSelectionFeatureId('sketch1')
    useSketchEditorStore.getState().commitPlaneSelection('face:sketch0:?3;@sketch0abc:face')
    expect(mutations[0].plane).toBe('?3;@sketch0abc:face')
  })
})

// 4f: commitPlaneSelection with @featureId (feature-plane reference)
// Selecting a sketch from the feature tree produces @sketch1 as the selection ID.
// commitPlaneSelection must store it verbatim as the plane query so the solver
// can resolve it to the sketch's defining plane.
describe('commitPlaneSelection with @featureId', () => {
  beforeEach(reset)

  it('stores @sketch1 as plane verbatim', () => {
    const mutations: unknown[] = []
    useSketchEditorStore.getState().setOnMutation(m => mutations.push(m))
    useSketchEditorStore.getState().setPlaneSelectionFeatureId('sketch2')
    useSketchEditorStore.getState().commitPlaneSelection('@sketch1')
    expect(mutations[0]).toEqual({ type: 'set_feature_plane', featureId: 'sketch2', plane: '@sketch1' })
    expect(useSketchEditorStore.getState().planeSelectionFeatureId).toBeNull()
  })

  it('stores @extrude1 as plane verbatim (future: resolves to top/origin face)', () => {
    const mutations: unknown[] = []
    useSketchEditorStore.getState().setOnMutation(m => mutations.push(m))
    useSketchEditorStore.getState().setPlaneSelectionFeatureId('sketch1')
    useSketchEditorStore.getState().commitPlaneSelection('@extrude1')
    expect(mutations[0]).toEqual({ type: 'set_feature_plane', featureId: 'sketch1', plane: '@extrude1' })
  })
})

// 4e: commitPlaneSelection is no-op when mode is inactive
describe('commitPlaneSelection no-op when inactive', () => {
  beforeEach(reset)

  it('emits nothing when planeSelectionFeatureId is null', () => {
    const mutations: unknown[] = []
    useSketchEditorStore.getState().setOnMutation(m => mutations.push(m))
    useSketchEditorStore.getState().commitPlaneSelection('@builtin_plane_top')
    expect(mutations).toHaveLength(0)
  })
})

// 4i: cancel_plane_selection command
describe('cancel_plane_selection command', () => {
  beforeEach(() => {
    reset()
    registerCommand('cancel_plane_selection', () => {
      useSketchEditorStore.getState().setPlaneSelectionFeatureId(null)
    })
  })

  it('dispatching cancel_plane_selection clears planeSelectionFeatureId', () => {
    useSketchEditorStore.getState().setPlaneSelectionFeatureId('sketch1')
    executeCommand('cancel_plane_selection')
    expect(useSketchEditorStore.getState().planeSelectionFeatureId).toBeNull()
  })

  it('unregister cleanup', () => {
    unregisterCommand('cancel_plane_selection')
  })
})
