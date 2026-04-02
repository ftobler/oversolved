import { describe, it, expect, beforeEach } from 'vitest'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'

function reset() {
  useSketchEditorStore.setState({
    fieldPickState: null,
    onMutation: null,
    planeSelectionFeatureId: null,
  })
}

describe('fieldPickState initial state', () => {
  it('is null by default', () => {
    reset()
    expect(useSketchEditorStore.getState().fieldPickState).toBeNull()
  })
})

describe('setFieldPickState', () => {
  beforeEach(reset)

  it('sets plane pick state', () => {
    useSketchEditorStore.getState().setFieldPickState({ featureId: 'plane1', field: 'plane', kind: 'plane' })
    expect(useSketchEditorStore.getState().fieldPickState).toEqual({ featureId: 'plane1', field: 'plane', kind: 'plane' })
  })

  it('sets point pick state', () => {
    useSketchEditorStore.getState().setFieldPickState({ featureId: 'plane1', field: 'p1', kind: 'point' })
    expect(useSketchEditorStore.getState().fieldPickState).toEqual({ featureId: 'plane1', field: 'p1', kind: 'point' })
  })

  it('clears with null', () => {
    useSketchEditorStore.getState().setFieldPickState({ featureId: 'plane1', field: 'plane', kind: 'plane' })
    useSketchEditorStore.getState().setFieldPickState(null)
    expect(useSketchEditorStore.getState().fieldPickState).toBeNull()
  })
})

describe('commitFieldPick with builtin plane', () => {
  beforeEach(reset)

  it('dispatches set_plane_definition_field and clears fieldPickState', () => {
    const mutations: unknown[] = []
    useSketchEditorStore.getState().setOnMutation(m => mutations.push(m))
    useSketchEditorStore.getState().setFieldPickState({ featureId: 'plane1', field: 'plane', kind: 'plane' })
    useSketchEditorStore.getState().commitFieldPick('@builtin_plane_top')
    expect(mutations[0]).toEqual({ type: 'set_plane_definition_field', featureId: 'plane1', field: 'plane', value: '@builtin_plane_top' })
    expect(useSketchEditorStore.getState().fieldPickState).toBeNull()
  })
})

describe('commitFieldPick with face ID', () => {
  beforeEach(reset)

  it('strips face:<featureId>: prefix', () => {
    const mutations: { value?: unknown }[] = []
    useSketchEditorStore.getState().setOnMutation(m => mutations.push(m as { value?: unknown }))
    useSketchEditorStore.getState().setFieldPickState({ featureId: 'plane1', field: 'plane', kind: 'plane' })
    useSketchEditorStore.getState().commitFieldPick('face:sketch0:?3;@sketch0abc')
    expect(mutations[0].value).toBe('?3;@sketch0abc')
  })
})

describe('commitFieldPick with vertex ID', () => {
  beforeEach(reset)

  it('converts vertex ID to query string', () => {
    const mutations: { value?: unknown }[] = []
    useSketchEditorStore.getState().setOnMutation(m => mutations.push(m as { value?: unknown }))
    useSketchEditorStore.getState().setFieldPickState({ featureId: 'plane1', field: 'p1', kind: 'point' })
    useSketchEditorStore.getState().commitFieldPick('vertex:sketch1:line1:start')
    expect(mutations[0].value).toBe('@sketch1line1start')
  })
})

describe('commitFieldPick no-op when inactive', () => {
  beforeEach(reset)

  it('emits nothing when fieldPickState is null', () => {
    const mutations: unknown[] = []
    useSketchEditorStore.getState().setOnMutation(m => mutations.push(m))
    useSketchEditorStore.getState().commitFieldPick('@builtin_plane_top')
    expect(mutations).toHaveLength(0)
  })
})
