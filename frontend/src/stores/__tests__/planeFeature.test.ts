import { describe, it, expect, beforeEach } from 'vitest'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'

function reset() {
  useSketchEditorStore.setState({
    pendingPickField: null,
    normalSelection: new Set(),
    selectionDomain: 'sketch_2d',
    onMutation: null,
    planeSelectionFeatureId: null,
  })
}

describe('pendingPickField initial state', () => {
  it('is null by default', () => {
    reset()
    expect(useSketchEditorStore.getState().pendingPickField).toBeNull()
  })
})

describe('setPendingPickField', () => {
  beforeEach(reset)

  it('sets plane pick field', () => {
    useSketchEditorStore.getState().setPendingPickField({ featureId: 'plane1', field: 'plane' })
    expect(useSketchEditorStore.getState().pendingPickField).toEqual({ featureId: 'plane1', field: 'plane' })
  })

  it('sets point pick field', () => {
    useSketchEditorStore.getState().setPendingPickField({ featureId: 'plane1', field: 'p1' })
    expect(useSketchEditorStore.getState().pendingPickField).toEqual({ featureId: 'plane1', field: 'p1' })
  })

  it('clears with null', () => {
    useSketchEditorStore.getState().setPendingPickField({ featureId: 'plane1', field: 'plane' })
    useSketchEditorStore.getState().setPendingPickField(null)
    expect(useSketchEditorStore.getState().pendingPickField).toBeNull()
  })
})

describe('commitFieldPick with builtin plane in normalSelection', () => {
  beforeEach(reset)

  it('dispatches set_plane_definition_field and clears pendingPickField and normalSelection', () => {
    const mutations: unknown[] = []
    useSketchEditorStore.getState().setOnMutation(m => mutations.push(m))
    useSketchEditorStore.getState().setPendingPickField({ featureId: 'plane1', field: 'plane' })
    useSketchEditorStore.setState({ normalSelection: new Set(['@builtin_plane_top']) })
    useSketchEditorStore.getState().commitFieldPick()
    expect(mutations[0]).toEqual({ type: 'set_plane_definition_field', featureId: 'plane1', field: 'plane', value: '@builtin_plane_top' })
    expect(useSketchEditorStore.getState().pendingPickField).toBeNull()
    expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
  })
})

describe('commitFieldPick with face ID in normalSelection', () => {
  beforeEach(reset)

  it('strips face:<featureId>: prefix', () => {
    const mutations: { value?: unknown }[] = []
    useSketchEditorStore.getState().setOnMutation(m => mutations.push(m as { value?: unknown }))
    useSketchEditorStore.getState().setPendingPickField({ featureId: 'plane1', field: 'plane' })
    useSketchEditorStore.setState({ normalSelection: new Set(['face:sketch0:?3;@sketch0abc']) })
    useSketchEditorStore.getState().commitFieldPick()
    expect(mutations[0].value).toBe('?3;@sketch0abc')
  })
})

describe('commitFieldPick with vertex ID in normalSelection', () => {
  beforeEach(reset)

  it('converts vertex ID to query string', () => {
    const mutations: { value?: unknown }[] = []
    useSketchEditorStore.getState().setOnMutation(m => mutations.push(m as { value?: unknown }))
    useSketchEditorStore.getState().setPendingPickField({ featureId: 'plane1', field: 'p1' })
    useSketchEditorStore.setState({ normalSelection: new Set(['vertex:sketch1:line1:start']) })
    useSketchEditorStore.getState().commitFieldPick()
    expect(mutations[0].value).toBe('@sketch1line1start')
  })
})

describe('commitFieldPick no-op when pendingPickField is null', () => {
  beforeEach(reset)

  it('emits nothing when pendingPickField is null', () => {
    const mutations: unknown[] = []
    useSketchEditorStore.getState().setOnMutation(m => mutations.push(m))
    useSketchEditorStore.setState({ normalSelection: new Set(['@builtin_plane_top']) })
    useSketchEditorStore.getState().commitFieldPick()
    expect(mutations).toHaveLength(0)
  })
})

describe('commitFieldPick with sketch field and face ID in normalSelection', () => {
  beforeEach(reset)

  it('dispatches set_extrude_sketch using featureId from face: prefix', () => {
    const mutations: unknown[] = []
    useSketchEditorStore.getState().setOnMutation(m => mutations.push(m))
    useSketchEditorStore.getState().setPendingPickField({ featureId: 'extrude1', field: 'sketch' })
    useSketchEditorStore.setState({ normalSelection: new Set(['face:sketch1:?some;query']) })
    useSketchEditorStore.getState().commitFieldPick()
    expect(mutations[0]).toEqual({ type: 'set_extrude_sketch', featureId: 'extrude1', sketchQuery: '$sketch1' })
    expect(useSketchEditorStore.getState().pendingPickField).toBeNull()
    expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
  })
})

describe('commitFieldPick no-op when normalSelection is empty', () => {
  beforeEach(reset)

  it('emits nothing when nothing is selected', () => {
    const mutations: unknown[] = []
    useSketchEditorStore.getState().setOnMutation(m => mutations.push(m))
    useSketchEditorStore.getState().setPendingPickField({ featureId: 'plane1', field: 'plane' })
    useSketchEditorStore.getState().commitFieldPick()
    expect(mutations).toHaveLength(0)
    expect(useSketchEditorStore.getState().pendingPickField).toEqual({ featureId: 'plane1', field: 'plane' })
  })
})
