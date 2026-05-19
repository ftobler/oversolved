import { describe, it, expect, beforeEach } from 'vitest'
import { dispatchSketchDrag } from '../dispatchSketchClick'
import { useSketchEditorStore, setSketchCallback } from '@/stores/sketchEditorStore'
import { toolRegistry } from '@/registry/toolRegistry'
import { createDragTool } from '@/tools/DragTool'

// Ensure DragTool is in the registry for these tests.
try { toolRegistry.register(createDragTool()) } catch { /* already registered */ }

beforeEach(() => {
  useSketchEditorStore.setState({
    activeTool: null,
    activeFeatureId: null,
    drag: null,
    dragPending: null,
    dragStartClient: null,
    orbitEnabled: true,
    isPointerDown: false,
    hoveredVertexId: null,
    hoveredVertexPosition: null,
    hoveredSnapKind: null,
    normalSelection: new Set(),
    internalHoverSelection: null,
    dynamicSelection: new Set(),
    dragSnap: null,
  })
  setSketchCallback('onMutation', null)
  setSketchCallback('onRebuild', null)
  setSketchCallback('onExitSketch', null)
})

describe('dispatchSketchDrag guard logic', () => {
  it('proceeds when activeTool is null (default select/drag mode)', () => {
    useSketchEditorStore.setState({
      activeTool: null,
      activeFeatureId: 'feat1',
    })

    dispatchSketchDrag(
      'vertex:feat1:line1:start', 'feat1', 'line1', 'start',
      10, 20, 100, 200,
    )

    const s = useSketchEditorStore.getState()
    expect(s.isPointerDown).toBe(true)
    expect(s.orbitEnabled).toBe(false)
    expect(s.dragStartClient).toEqual([100, 200])
    expect(s.dragPending).not.toBeNull()
    expect(s.dragPending!.type).toBe('vertex')
    if (s.dragPending!.type === 'vertex' || s.dragPending!.type === 'edge') {
      expect(s.dragPending!.vertexId).toBe('vertex:feat1:line1:start')
    }
  })

  it('proceeds when activeTool is drag', () => {
    useSketchEditorStore.setState({
      activeTool: 'drag',
      activeFeatureId: 'feat1',
    })

    dispatchSketchDrag(
      'vertex:feat1:line1:start', 'feat1', 'line1', 'start',
      10, 20, 100, 200,
    )

    const s = useSketchEditorStore.getState()
    expect(s.isPointerDown).toBe(true)
    expect(s.orbitEnabled).toBe(false)
    expect(s.dragPending).not.toBeNull()
  })

  it('blocks when activeTool is a drawing tool (line)', () => {
    useSketchEditorStore.setState({
      activeTool: 'line',
      activeFeatureId: 'feat1',
    })

    dispatchSketchDrag(
      'vertex:feat1:line1:start', 'feat1', 'line1', 'start',
      10, 20, 100, 200,
    )

    const s = useSketchEditorStore.getState()
    expect(s.isPointerDown).toBe(false)
    expect(s.orbitEnabled).toBe(true)
    expect(s.dragPending).toBeNull()
  })

  it('blocks when activeFeatureId is null (no sketch being edited)', () => {
    useSketchEditorStore.setState({
      activeTool: null,
      activeFeatureId: null,
    })

    dispatchSketchDrag(
      'vertex:feat1:line1:start', 'feat1', 'line1', 'start',
      10, 20, 100, 200,
    )

    const s = useSketchEditorStore.getState()
    expect(s.isPointerDown).toBe(false)
    expect(s.orbitEnabled).toBe(true)
    expect(s.dragPending).toBeNull()
  })

  it('blocks when activeFeatureId does not match the featureId param', () => {
    useSketchEditorStore.setState({
      activeTool: null,
      activeFeatureId: 'feat2',
    })

    dispatchSketchDrag(
      'vertex:feat1:line1:start', 'feat1', 'line1', 'start',
      10, 20, 100, 200,
    )

    const s = useSketchEditorStore.getState()
    expect(s.isPointerDown).toBe(false)
    expect(s.orbitEnabled).toBe(true)
    expect(s.dragPending).toBeNull()
  })

  it('sets dragPending with correct fields when drag is initiated', () => {
    useSketchEditorStore.setState({
      activeTool: null,
      activeFeatureId: 'feat1',
      hoveredVertexId: 'vertex:feat1:line1:start',
      hoveredVertexPosition: [10, 20],
      hoveredSnapKind: 'vertex',
    })

    dispatchSketchDrag(
      'vertex:feat1:line1:start', 'feat1', 'line1', 'start',
      10, 20, 100, 200,
    )

    const s = useSketchEditorStore.getState()
    expect(s.isPointerDown).toBe(true)
    expect(s.dragPending).toMatchObject({
      type: 'vertex',
      vertexId: 'vertex:feat1:line1:start',
      featureId: 'feat1',
      entityId: 'line1',
      vertexKey: 'start',
      startWorld: [10, 20],
    })
  })
})
