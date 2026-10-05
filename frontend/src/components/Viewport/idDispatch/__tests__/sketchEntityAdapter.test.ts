import { describe, it, expect, beforeEach } from 'vitest'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { toolRegistry } from '@/registry/toolRegistry'
import { initializeTools } from '@/tools'
import { sketchEntityAdapter } from '../sketchEntityAdapter'

beforeEach(() => {
  toolRegistry.reset()
  initializeTools()
})

beforeEach(() => {
  useSketchEditorStore.setState({
    activeTool: null,
    activeFeatureId: null,
    hoveredSelectionId: null,
    isPointerDown: false,
    dragPending: null,
    dragStartClient: null,
    drag: null,
  })
})

describe('sketchEntityAdapter', () => {
  it('onHover sets hoveredSelectionId', () => {
    sketchEntityAdapter.onHover('entity:feat1:line1')
    const s = useSketchEditorStore.getState()
    expect(s.hoveredSelectionId).toBe('entity:feat1:line1')
  })

  it('setHoveredSelectionId(null) clears hoveredSelectionId', () => {
    sketchEntityAdapter.onHover('entity:feat1:arc1')
    useSketchEditorStore.getState().setHoveredSelectionId(null)
    const s = useSketchEditorStore.getState()
    expect(s.hoveredSelectionId).toBeNull()
  })

  it('onPointerDown starts entity drag for valid entity key', () => {
    useSketchEditorStore.setState({ activeFeatureId: 'feat1' })
    sketchEntityAdapter.onPointerDown('entity:feat1:line1', 100, 200)
    const s = useSketchEditorStore.getState()
    expect(s.isPointerDown).toBe(true)
    expect(s.dragStartClient).toEqual([100, 200])
    expect(s.dragPending).not.toBeNull()
    expect(s.dragPending!.type).toBe('edge')
    if (s.dragPending!.type === 'vertex' || s.dragPending!.type === 'edge') {
      expect(s.dragPending!.vertexId).toBe('entity:feat1:line1')
      expect(s.dragPending!.featureId).toBe('feat1')
      expect(s.dragPending!.entityId).toBe('line1')
    }
  })

  it('onPointerDown does not start entity drag when activeFeatureId is null', () => {
    sketchEntityAdapter.onPointerDown('entity:feat1:line1', 100, 200)
    const s = useSketchEditorStore.getState()
    expect(s.isPointerDown).toBe(false)
    expect(s.dragPending).toBeNull()
  })

  it('onPointerDown is a no-op for non-entity keys', () => {
    useSketchEditorStore.setState({ activeFeatureId: 'feat1' })
    sketchEntityAdapter.onPointerDown('vertex:feat1:line1:start', 100, 200)
    const s = useSketchEditorStore.getState()
    expect(s.isPointerDown).toBe(false)
    expect(s.dragPending).toBeNull()
  })

  it('onPointerDown is a no-op for an entity key missing its entity id', () => {
    useSketchEditorStore.setState({ activeFeatureId: 'feat1' })
    sketchEntityAdapter.onPointerDown('entity:feat1', 100, 200)
    const s = useSketchEditorStore.getState()
    expect(s.isPointerDown).toBe(false)
    expect(s.dragPending).toBeNull()
  })

  it('onClick under the idle tool toggles the entity into normalSelection', () => {
    useSketchEditorStore.setState({ entityKindMap: { 'entity:feat1:circle1': 'circle' }, normalSelection: new Set() })
    sketchEntityAdapter.onClick('entity:feat1:circle1', 100, 100)
    const s = useSketchEditorStore.getState()
    expect(s.normalSelection.has('entity:feat1:circle1')).toBe(true)
    expect(s.activeTool).toBeNull()
  })

  it('onClick under the dimension tool lands a pick carrying the entityKind from entityKindMap', () => {
    useSketchEditorStore.setState({
      entityKindMap: { 'entity:feat1:circle1': 'circle' },
      activeTool: 'dimension',
      activeFeatureId: 'feat1',
      dimensionPicks: [],
    })
    sketchEntityAdapter.onClick('entity:feat1:circle1', 100, 100)
    const s = useSketchEditorStore.getState()
    expect(s.dimensionPicks).toEqual([
      { isVertex: false, target: 'entity:feat1:circle1', entityKind: 'circle' },
    ])
    expect(s.activeTool).toBe('dimension')
  })
})
