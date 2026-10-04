import { describe, it, expect, beforeEach } from 'vitest'
import { dispatchSketchClick, dispatchDragInitiation } from '../dispatchSketchClick'
import { useSketchEditorStore, setSketchCallback } from '@/stores/sketchEditorStore'
import { toolRegistry } from '@/registry/toolRegistry'
import { initializeTools } from '@/tools'

beforeEach(() => {
  toolRegistry.reset()
  initializeTools()
})

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

  it('refuses to start a second pending gesture while a drag is active', () => {
    // A second finger pressing a vertex on another sketch mid-drag used to
    // overwrite dragPending, which the first finger's release then cleared,
    // killing gesture B and unlocking the camera while finger B was still down.
    useSketchEditorStore.setState({
      activeTool: null,
      activeFeatureId: 'feat1',
      drag: {
        type: 'vertex', vertexId: 'vertex:feat1:line1:start', featureId: 'feat1',
        entityId: 'line1', vertexKey: 'start', startWorld: [0, 0],
        currentWorld: [1, 1], startClient: [0, 0],
      },
      dragPending: null,
      dragStartClient: [0, 0],
      isPointerDown: true,
    })

    dispatchDragInitiation(
      'vertex:feat1:line2:start', 'feat1', 'line2', 'start',
      300, 400,
    )

    const s = useSketchEditorStore.getState()
    expect(s.dragPending).toBeNull()
    expect(s.dragStartClient).toEqual([0, 0])
    expect(s.isPointerDown).toBe(true)
  })
})

describe('dispatchSketchClick null-tool fallback (idle select contract)', () => {
  // dispatchSketchClick only runs for a resolved hit; an empty-space click
  // never reaches it. The clear half of the deleted SelectionTool contract is
  // owned by the DrawPlane backplane (Drawing.tsx) + Viewport onPointerMissed,
  // gated by shouldClearSelectionOnBackplaneClick (pinned by
  // backplaneClearGuard.test.tsx). These tests pin the toggle half, which the
  // fallback itself owns.
  beforeEach(() => {
    useSketchEditorStore.setState({
      activeTool: null,
      activeFeatureId: 'S1',
      hoveredSelectionId: null,
      hoveredVertexId: null,
      normalSelection: new Set(),
    })
  })

  it('idle click on a sketch entity toggles it into normal selection', () => {
    dispatchSketchClick('entity:S1:L1', 'line', 100, 100)
    const s = useSketchEditorStore.getState()
    expect(s.normalSelection.has('entity:S1:L1')).toBe(true)
  })

  it('idle click on an already-selected entity toggles it back out', () => {
    useSketchEditorStore.setState({ normalSelection: new Set(['entity:S1:L1']) })
    dispatchSketchClick('entity:S1:L1', 'line', 100, 100)
    const s = useSketchEditorStore.getState()
    expect(s.normalSelection.has('entity:S1:L1')).toBe(false)
  })

  // sketchVertexAdapter (sketchVertexAdapter.ts) hands no entityKind (undefined)
  // to the shared dispatch, so pin that call contract: the fallback must not
  // depend on the kind being present.
  it('idle click from the vertex adapter (no entityKind) toggles too', () => {
    dispatchSketchClick('vertex:S1:P1:xy', undefined, 100, 100)
    const s = useSketchEditorStore.getState()
    expect(s.normalSelection.has('vertex:S1:P1:xy')).toBe(true)
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

  // The dimension tool owns an onClick handler, so its click must route to the
  // tool and never fall through to the toggleNormalSelection fallback. A toggle
  // on the pick target would silently add it to the selection on top of the
  // dimension pick, which is not how the tool behaves.
  it('dimension click routes to the tool, never the toggle fallback', () => {
    dispatchSketchClick('entity:S1:L1', 'line', 100, 100)
    const s = useSketchEditorStore.getState()
    expect(s.dimensionPicks).toHaveLength(1)
    expect(s.normalSelection.has('entity:S1:L1')).toBe(false)
  })

  // No active sketch means no-op from BOTH layers: dispatchSketchClick bails
  // before any handler runs, and DimensionTool.onClick has its own
  // `!context.activeFeatureId` guard, so neither a pick nor a selection toggle
  // may happen for a click the tool cannot act on even if one guard regresses.
  it('dimension click outside a sketch does not pick or toggle', () => {
    useSketchEditorStore.setState({ activeFeatureId: null })
    dispatchSketchClick('entity:S1:L1', 'line', 100, 100)
    const s = useSketchEditorStore.getState()
    expect(s.dimensionPicks).toHaveLength(0)
    expect(s.normalSelection.size).toBe(0)
  })
})
