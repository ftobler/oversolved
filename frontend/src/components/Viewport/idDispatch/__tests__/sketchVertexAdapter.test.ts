import { describe, it, expect, beforeEach } from 'vitest'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { toolRegistry } from '@/registry/toolRegistry'
import { createDragTool } from '@/tools/DragTool'
import { sketchVertexAdapter, clearSketchVertexHover } from '../sketchVertexAdapter'

try { toolRegistry.register(createDragTool()) } catch { /* already registered */ }

beforeEach(() => {
  useSketchEditorStore.setState({
    activeTool: null,
    activeFeatureId: null,
    hoveredVertexId: null,
    hoveredVertexPosition: null,
    hoveredSnapKind: null,
    isPointerDown: false,
    orbitEnabled: true,
    dragPending: null,
    dragStartClient: null,
    drag: null,
  })
})

describe('sketchVertexAdapter', () => {
  it('onHover sets hoveredVertexId and snapKind', () => {
    sketchVertexAdapter.onHover('vertex:feat1:line1:start')
    const s = useSketchEditorStore.getState()
    expect(s.hoveredVertexId).toBe('vertex:feat1:line1:start')
    expect(s.hoveredSnapKind).toBe('vertex')
  })

  it('onPointerDown starts drag for a valid vertex key when activeTool is null', () => {
    useSketchEditorStore.setState({ activeFeatureId: 'feat1' })
    sketchVertexAdapter.onPointerDown('vertex:feat1:line1:start', 100, 200)
    const s = useSketchEditorStore.getState()
    expect(s.isPointerDown).toBe(true)
    expect(s.orbitEnabled).toBe(false)
    expect(s.dragPending).not.toBeNull()
    expect(s.dragPending!.type).toBe('vertex')
    if (s.dragPending!.type === 'vertex' || s.dragPending!.type === 'edge') {
      expect(s.dragPending!.vertexId).toBe('vertex:feat1:line1:start')
    }
    expect(s.dragStartClient).toEqual([100, 200])
  })

  it('onPointerDown does not start drag when activeFeatureId is null', () => {
    sketchVertexAdapter.onPointerDown('vertex:feat1:line1:start', 100, 200)
    const s = useSketchEditorStore.getState()
    expect(s.isPointerDown).toBe(false)
    expect(s.dragPending).toBeNull()
  })

  it('onPointerDown is a no-op for non-vertex entity keys', () => {
    useSketchEditorStore.setState({ activeFeatureId: 'feat1' })
    sketchVertexAdapter.onPointerDown('entity:feat1:line1', 100, 200)
    const s = useSketchEditorStore.getState()
    expect(s.isPointerDown).toBe(false)
    expect(s.dragPending).toBeNull()
  })

  it('clearSketchVertexHover clears all vertex hover fields', () => {
    sketchVertexAdapter.onHover('vertex:feat1:arc1:center')
    clearSketchVertexHover()
    const s = useSketchEditorStore.getState()
    expect(s.hoveredVertexId).toBeNull()
    expect(s.hoveredVertexPosition).toBeNull()
    expect(s.hoveredSnapKind).toBeNull()
  })
})
