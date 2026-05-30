import { describe, it, expect, beforeEach } from 'vitest'
import { arePickBodiesInteractive } from '../bodyInteractivity'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'

describe('arePickBodiesInteractive', () => {
  beforeEach(() => {
    useSketchEditorStore.getState().setActiveTool(null)
  })

  it('bodies interactive when no sketch is being edited', () => {
    expect(arePickBodiesInteractive(null, null)).toBe(true)
    expect(arePickBodiesInteractive(undefined, null)).toBe(true)
    expect(arePickBodiesInteractive(undefined, { featureId: 'sk1', field: 'plane' })).toBe(true)
  })

  it('bodies inert while editing a sketch with no active plane pick', () => {
    expect(arePickBodiesInteractive('sk1', null)).toBe(false)
    expect(arePickBodiesInteractive('sk1', { featureId: 'sk1', field: 'edges' })).toBe(false)
  })

  it('bodies stay interactive during a plane pick so a solid face can be chosen as the sketch plane', () => {
    expect(arePickBodiesInteractive('sk1', { featureId: 'sk1', field: 'plane' })).toBe(true)
  })

  it('bodies stay interactive during project tool even while editing a sketch', () => {
    useSketchEditorStore.getState().setActiveTool('project')
    expect(arePickBodiesInteractive('sk1', null)).toBe(true)
    expect(arePickBodiesInteractive('sk1', { featureId: 'sk1', field: 'edges' })).toBe(true)
  })

  it('project tool effect clears when tool is deactivated', () => {
    useSketchEditorStore.getState().setActiveTool('project')
    expect(arePickBodiesInteractive('sk1', null)).toBe(true)
    useSketchEditorStore.getState().setActiveTool('select')
    expect(arePickBodiesInteractive('sk1', null)).toBe(false)
  })
})
