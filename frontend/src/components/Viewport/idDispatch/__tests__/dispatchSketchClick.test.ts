import { describe, it, expect, beforeEach } from 'vitest'
import { dispatchSketchClick, dispatchDragInitiation } from '../dispatchSketchClick'
import { useSketchEditorStore, setSketchCallback } from '@/stores/sketchEditorStore'
import { toolRegistry } from '@/registry/toolRegistry'
import { createDragTool } from '@/tools/DragTool'
import { createDimensionTool } from '@/tools/DimensionTool'

// Ensure DragTool and DimensionTool are in the registry for these tests.
try { toolRegistry.register(createDragTool()) } catch { /* already registered */ }
try { toolRegistry.register(createDimensionTool()) } catch { /* already registered */ }

beforeEach(() => {
  useSketchEditorStore.setState({
    activeTool: null,
    activeFeatureId: null,
    drag: null,
    dragPending: null,
    dragStartClient: null,
    isPointerDown: false,
    hoveredVertexId: null,
    hoveredVertexPosition: null,
    hoveredSnapKind: null,
    normalSelection: new Set(),
    hoveredSelectionId: null,
    dragSnap: null,
  })
  setSketchCallback('onMutation', null)
  setSketchCallback('onRebuild', null)
  setSketchCallback('onExitSketch', null)
})

describe('dispatchDragInitiation guard logic', () => {
  it('unified vertex dispatch proceeds when activeTool is null', () => {
    useSketchEditorStore.setState({
      activeTool: null,
      activeFeatureId: 'feat1',
    })

    dispatchDragInitiation(
      'vertex:feat1:line1:start', 'feat1', 'line1', 'start',
      100, 200,
    )

    const s = useSketchEditorStore.getState()
    expect(s.isPointerDown).toBe(true)
    expect(s.dragStartClient).toEqual([100, 200])
    expect(s.dragPending).not.toBeNull()
    expect(s.dragPending!.type).toBe('vertex')
    if (s.dragPending!.type === 'vertex' || s.dragPending!.type === 'edge') {
      expect(s.dragPending!.vertexId).toBe('vertex:feat1:line1:start')
    }
  })

  it('unified edge dispatch passes vertexKey=edge', () => {
    useSketchEditorStore.setState({
      activeTool: null,
      activeFeatureId: 'feat1',
    })

    dispatchDragInitiation(
      'entity:feat1:line1', 'feat1', 'line1', 'edge',
      100, 200,
    )

    const s = useSketchEditorStore.getState()
    expect(s.isPointerDown).toBe(true)
    expect(s.dragStartClient).toEqual([100, 200])
    expect(s.dragPending).not.toBeNull()
    expect(s.dragPending!.type).toBe('edge')
  })

  it('proceeds when activeTool is drag', () => {
    useSketchEditorStore.setState({
      activeTool: 'drag',
      activeFeatureId: 'feat1',
    })

    dispatchDragInitiation(
      'vertex:feat1:line1:start', 'feat1', 'line1', 'start',
      100, 200,
    )

    const s = useSketchEditorStore.getState()
    expect(s.isPointerDown).toBe(true)
    expect(s.dragPending).not.toBeNull()
  })

  it('blocks when activeTool is a drawing tool (line)', () => {
    useSketchEditorStore.setState({
      activeTool: 'line',
      activeFeatureId: 'feat1',
    })

    dispatchDragInitiation(
      'vertex:feat1:line1:start', 'feat1', 'line1', 'start',
      100, 200,
    )

    const s = useSketchEditorStore.getState()
    expect(s.isPointerDown).toBe(false)
    expect(s.dragPending).toBeNull()
  })

  it('blocks when activeFeatureId is null', () => {
    useSketchEditorStore.setState({
      activeTool: null,
      activeFeatureId: null,
    })

    dispatchDragInitiation(
      'vertex:feat1:line1:start', 'feat1', 'line1', 'start',
      100, 200,
    )

    const s = useSketchEditorStore.getState()
    expect(s.isPointerDown).toBe(false)
    expect(s.dragPending).toBeNull()
  })

  it('blocks when activeFeatureId does not match featureId param', () => {
    useSketchEditorStore.setState({
      activeTool: null,
      activeFeatureId: 'feat2',
    })

    dispatchDragInitiation(
      'vertex:feat1:line1:start', 'feat1', 'line1', 'start',
      100, 200,
    )

    const s = useSketchEditorStore.getState()
    expect(s.isPointerDown).toBe(false)
    expect(s.dragPending).toBeNull()
  })
})

describe('dispatchSketchClick with entityKind (sticky placement)', () => {
  beforeEach(() => {
    useSketchEditorStore.setState({
      activeTool: 'dimension',
      activeFeatureId: 'S1',
      hoveredSelectionId: null,
      hoveredVertexId: null,
      dimensionPicks: [],
      pendingDialog: null,
      normalSelection: new Set(),
    })
  })

  it('circle entityKind appends to dimensionPicks (no dialog yet)', () => {
    useSketchEditorStore.setState({ hoveredSelectionId: 'entity:S1:C1' })
    dispatchSketchClick('entity:S1:C1', 'circle', 100, 100)
    const s = useSketchEditorStore.getState()
    expect(s.pendingDialog).toBeNull()
    expect(s.dimensionPicks).toEqual([
      { isVertex: false, target: 'entity:S1:C1', entityKind: 'circle' },
    ])
  })

  it('line entityKind appends to dimensionPicks (no dialog yet)', () => {
    useSketchEditorStore.setState({ hoveredSelectionId: 'entity:S1:L1' })
    dispatchSketchClick('entity:S1:L1', 'line', 100, 100)
    const s = useSketchEditorStore.getState()
    expect(s.pendingDialog).toBeNull()
    expect(s.dimensionPicks).toEqual([
      { isVertex: false, target: 'entity:S1:L1', entityKind: 'line' },
    ])
  })
})
