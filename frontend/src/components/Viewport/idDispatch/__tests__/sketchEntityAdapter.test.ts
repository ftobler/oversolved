import { describe, it, expect, beforeEach } from 'vitest'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { toolRegistry } from '@/registry/toolRegistry'
import { createDragTool } from '@/tools/DragTool'
import { sketchEntityAdapter, clearSketchEntityHover } from '../sketchEntityAdapter'

try { toolRegistry.register(createDragTool()) } catch { /* already registered */ }

beforeEach(() => {
  useSketchEditorStore.setState({
    activeTool: null,
    activeFeatureId: null,
    internalHoverSelection: null,
    hoveredEntityId: null,
    isPointerDown: false,
    orbitEnabled: true,
    dragPending: null,
    dragStartClient: null,
    drag: null,
  })
})

describe('sketchEntityAdapter', () => {
  it('onHover sets internalHoverSelection and hoveredEntityId', () => {
    sketchEntityAdapter.onHover('entity:feat1:line1')
    const s = useSketchEditorStore.getState()
    expect(s.internalHoverSelection).toBe('entity:feat1:line1')
    expect(s.hoveredEntityId).toBe('entity:feat1:line1')
  })

  it('clearSketchEntityHover clears both fields', () => {
    sketchEntityAdapter.onHover('entity:feat1:arc1')
    clearSketchEntityHover()
    const s = useSketchEditorStore.getState()
    expect(s.internalHoverSelection).toBeNull()
    expect(s.hoveredEntityId).toBeNull()
  })

  it('onPointerDown starts entity drag for valid entity key', () => {
    useSketchEditorStore.setState({ activeFeatureId: 'feat1' })
    sketchEntityAdapter.onPointerDown('entity:feat1:line1', 100, 200)
    const s = useSketchEditorStore.getState()
    expect(s.isPointerDown).toBe(true)
    expect(s.orbitEnabled).toBe(false)
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
})
