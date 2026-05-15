import { describe, it, expect, beforeEach } from 'vitest'
import { useSketchEditorStore, setSketchCallback } from '@/stores/sketchEditorStore'

function reset() {
  useSketchEditorStore.setState({
    pendingPickField: null,
    normalSelection: new Set(),
    selectionDomain: 'sketch_2d',
    planeSelectionFeatureId: null,
  })
  setSketchCallback('onMutation', null)
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
    setSketchCallback('onMutation', m => mutations.push(m))
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
    setSketchCallback('onMutation', m => mutations.push(m as { value?: unknown }))
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
    setSketchCallback('onMutation', m => mutations.push(m as { value?: unknown }))
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
    setSketchCallback('onMutation', m => mutations.push(m))
    useSketchEditorStore.setState({ normalSelection: new Set(['@builtin_plane_top']) })
    useSketchEditorStore.getState().commitFieldPick()
    expect(mutations).toHaveLength(0)
  })
})

describe('commitFieldPick with sketch field and face ID in normalSelection', () => {
  beforeEach(reset)

  it('dispatches add_extrude_profile and keeps pick mode open', () => {
    const mutations: unknown[] = []
    setSketchCallback('onMutation', m => mutations.push(m))
    useSketchEditorStore.getState().setPendingPickField({ featureId: 'extrude1', field: 'sketch' })
    useSketchEditorStore.setState({ normalSelection: new Set(['face:sketch1:?some;query']) })
    useSketchEditorStore.getState().commitFieldPick()
    expect(mutations[0]).toEqual({ type: 'add_extrude_profile', featureId: 'extrude1', sketchQuery: '?some;query' })
    // pick mode stays open for multi-selection
    expect(useSketchEditorStore.getState().pendingPickField).toEqual({ featureId: 'extrude1', field: 'sketch' })
    expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
  })

  it('can add a second profile without closing pick mode', () => {
    const mutations: unknown[] = []
    setSketchCallback('onMutation', m => mutations.push(m))
    useSketchEditorStore.getState().setPendingPickField({ featureId: 'ex1', field: 'sketch' })
    useSketchEditorStore.setState({ normalSelection: new Set(['face:sk1:?q1;id']) })
    useSketchEditorStore.getState().commitFieldPick()
    useSketchEditorStore.setState({ normalSelection: new Set(['face:sk2:?q2;id']) })
    useSketchEditorStore.getState().commitFieldPick()
    expect(mutations).toHaveLength(2)
    expect(mutations[0]).toEqual({ type: 'add_extrude_profile', featureId: 'ex1', sketchQuery: '?q1;id' })
    expect(mutations[1]).toEqual({ type: 'add_extrude_profile', featureId: 'ex1', sketchQuery: '?q2;id' })
    expect(useSketchEditorStore.getState().pendingPickField).toEqual({ featureId: 'ex1', field: 'sketch' })
  })
})

describe('commitFieldPick no-op when normalSelection is empty', () => {
  beforeEach(reset)

  it('emits nothing when nothing is selected', () => {
    const mutations: unknown[] = []
    setSketchCallback('onMutation', m => mutations.push(m))
    useSketchEditorStore.getState().setPendingPickField({ featureId: 'plane1', field: 'plane' })
    useSketchEditorStore.getState().commitFieldPick()
    expect(mutations).toHaveLength(0)
    expect(useSketchEditorStore.getState().pendingPickField).toEqual({ featureId: 'plane1', field: 'plane' })
  })
})

describe('commitFieldPick with transform rotation_axis', () => {
  beforeEach(reset)

  it('dispatches set_transform_field for rotation_axis', () => {
    const mutations: unknown[] = []
    setSketchCallback('onMutation', m => mutations.push(m))
    useSketchEditorStore.getState().setPendingPickField({ featureId: 'xf1', field: 'rotation_axis', hostKind: 'transform' })
    useSketchEditorStore.setState({ normalSelection: new Set(['entity:sketch1:line1']) })
    useSketchEditorStore.getState().commitFieldPick()
    expect(mutations[0]).toEqual({ type: 'set_transform_field', featureId: 'xf1', field: 'rotation_axis', value: 'entity:sketch1:line1' })
    expect(useSketchEditorStore.getState().pendingPickField).toBeNull()
  })
})

describe('commitFieldPick with transform scale_center_from', () => {
  beforeEach(reset)

  it('dispatches set_transform_field for scale_center_from', () => {
    const mutations: unknown[] = []
    setSketchCallback('onMutation', m => mutations.push(m))
    useSketchEditorStore.getState().setPendingPickField({ featureId: 'xf1', field: 'scale_center_from', hostKind: 'transform' })
    useSketchEditorStore.setState({ normalSelection: new Set(['face:sketch1:?3;@sketch1abc']) })
    useSketchEditorStore.getState().commitFieldPick()
    expect(mutations[0]).toEqual({ type: 'set_transform_field', featureId: 'xf1', field: 'scale_center_from', value: '?3;@sketch1abc' })
    expect(useSketchEditorStore.getState().pendingPickField).toBeNull()
  })
})
