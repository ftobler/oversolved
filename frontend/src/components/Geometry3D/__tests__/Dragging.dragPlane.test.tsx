import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import * as THREE from 'three'
import { useSketchEditorStore, setSketchCallback } from '@/stores/sketchEditorStore'
import type { DragState, DragPendingState, VertexOrEdgeDrag } from '@/stores/sketchEditorStore'
import { toolRegistry } from '@/registry/toolRegistry'
import { initializeTools } from '@/tools'
import type { Sketch } from '@/types/cad'

/**
 * DragPlane is the window-level state machine behind a sketch drag. The pointer
 * handlers live on window (not on a mesh) and decide by store state alone:
 * which sketch owns the gesture, whether a pending press has moved far enough
 * to become a drag, how snap candidates are filtered, and what commits on
 * release. #266 and #274 both came out of this handler, so the contract is
 * pinned at the component seam rather than only in the pure dragLogic helpers.
 *
 * The projection seam is mocked so the world hit is stated directly; the real
 * sanitizePointerEvent then maps it through an identity sketch group, so the
 * local point equals the projected world point without a Canvas or camera math.
 */

const proj = vi.hoisted(() => ({ point: null as { x: number; y: number; z: number } | null, calls: 0 }))
vi.mock('@/components/Geometry3D/dragMathPlane', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/Geometry3D/dragMathPlane')>()
  return {
    ...actual,
    projectCursorToSketchPlane: () => {
      proj.calls++
      return proj.point
        ? ({ x: proj.point.x, y: proj.point.y, z: proj.point.z } as unknown as THREE.Vector3)
        : null
    },
  }
})

const r3f = vi.hoisted(() => ({ camera: null as unknown, canvas: null as unknown }))
vi.mock('@react-three/fiber', () => ({
  useThree: () => ({ camera: r3f.camera, gl: { domElement: r3f.canvas } }),
}))
vi.mock('@/components/Geometry3D/VertexDots', () => ({ Dot: () => null }))
vi.mock('@/components/Geometry3D/dimensions', () => ({ DashedLine: () => null }))

import { DragPlane } from '@/components/Geometry3D/Dragging'

function makeCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.getBoundingClientRect = () => ({
    x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600,
    toJSON() { return {} },
  })
  return c
}

const groupRef = { current: new THREE.Group() }

// Window-level listeners receive real DOM events; a MouseEvent carries clientX
// where testing-library's synthetic pointer event does not always.
function move(clientX: number, clientY: number): void {
  act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientX, clientY })) })
}

function up(clientX: number, clientY: number): void {
  act(() => { window.dispatchEvent(new MouseEvent('pointerup', { clientX, clientY })) })
}

function vertexDrag(featureId: string, over: Partial<VertexOrEdgeDrag> = {}): VertexOrEdgeDrag {
  return {
    type: 'vertex', vertexId: `vertex:${featureId}:lineA:start`, featureId,
    entityId: 'lineA', vertexKey: 'start', startWorld: [0, 0], currentWorld: [0, 0],
    startClient: [0, 0], ...over,
  }
}

function vertexPending(featureId: string): DragPendingState {
  return {
    type: 'vertex', vertexId: `vertex:${featureId}:lineA:start`, featureId,
    entityId: 'lineA', vertexKey: 'start', startWorld: [0, 0],
  }
}

function dimDrag(featureId: string, over: Partial<Extract<DragState, { type: 'dim_label' }>> = {}) {
  return {
    type: 'dim_label' as const, constraintId: 'c1', featureId,
    anchorWorld: [0, 0] as [number, number], startWorld: [0, 0] as [number, number],
    currentWorld: [3, 4] as [number, number], ...over,
  }
}

beforeEach(() => {
  toolRegistry.reset()
  initializeTools()
  proj.point = null
  proj.calls = 0
  r3f.camera = new THREE.OrthographicCamera(-10, 10, 10, -10, -100, 100)
  r3f.canvas = makeCanvas()
  setSketchCallback('onMutation', null)
  useSketchEditorStore.setState({
    drag: null, dragPending: null, dragStartClient: null, dragSnap: null,
    alignmentSnapPoint: null, alignmentSnapKind: null, isPointerDown: false,
    activeTool: null, activeFeatureId: 'S1', normalSelection: new Set(),
    hoveredVertexId: null, hoveredVertexPosition: null, hoveredSnapKind: null,
    hoveredSelectionId: null,
  })
})

afterEach(() => {
  setSketchCallback('onMutation', null)
})

describe('DragPlane move routing', () => {
  it('ignores a move whose drag belongs to another sketch', () => {
    useSketchEditorStore.setState({ drag: vertexDrag('S2') })
    render(<DragPlane featureId="S1" sketchGroupRef={groupRef} />)

    move(100, 100)

    expect(proj.calls).toBe(0)  // filtered before the projection seam
    expect((useSketchEditorStore.getState().drag as VertexOrEdgeDrag).currentWorld).toEqual([0, 0])
  })

  it('applies the move for the owning sketch at the projected local point', () => {
    useSketchEditorStore.setState({ drag: vertexDrag('S1') })
    proj.point = { x: 3, y: 4, z: 0 }
    render(<DragPlane featureId="S1" sketchGroupRef={groupRef} />)

    move(100, 100)

    expect((useSketchEditorStore.getState().drag as VertexOrEdgeDrag).currentWorld).toEqual([3, 4])
  })

  it('ignores a feature-handle drag (owned by FeatureHandles, not a sketch plane)', () => {
    useSketchEditorStore.setState({
      drag: {
        type: 'feature_handle', featureId: 'S1', field: 'depth', startValue: 1, currentValue: 1,
        axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], unitScale: 1, min: 0,
      },
    })
    render(<DragPlane featureId="S1" sketchGroupRef={groupRef} />)

    move(100, 100)

    expect(proj.calls).toBe(0)
  })

  it('leaves a pending press un-dragged until the click threshold is crossed', () => {
    useSketchEditorStore.setState({
      dragPending: vertexPending('S1'), dragStartClient: [100, 100], isPointerDown: true,
    })
    proj.point = { x: 5, y: 5, z: 0 }
    render(<DragPlane featureId="S1" sketchGroupRef={groupRef} />)

    move(101, 101)  // 1.4px, a click
    expect(useSketchEditorStore.getState().drag).toBeNull()

    move(200, 200)  // past the threshold
    const drag = useSketchEditorStore.getState().drag
    expect(drag).not.toBeNull()
    expect(drag!.type).toBe('vertex')
    expect((drag as VertexOrEdgeDrag).currentWorld).toEqual([5, 5])
  })
})

describe('DragPlane vertex snap candidates', () => {
  const sketch: Sketch = {
    lineA: { start: [0, 0], end: [1, 0] },
    lineB: { start: [5, 0], end: [10, 0] },
  }

  it('snaps the dragged vertex to another vertex under the cursor', () => {
    useSketchEditorStore.setState({ drag: vertexDrag('S1') })
    proj.point = { x: 10, y: 0, z: 0 }
    render(<DragPlane featureId="S1" sketch={sketch} sketchGroupRef={groupRef} />)

    move(500, 500)

    const s = useSketchEditorStore.getState()
    expect(s.dragSnap?.kind).toBe('vertex')
    expect(s.dragSnap?.vertexId).toBe('vertex:S1:lineB:end')
    expect(s.dragSnap?.position).toEqual([10, 0])
  })

  it('does not snap to a vertex of the entity being dragged', () => {
    // lineA:end sits under the cursor; it must be excluded by the dragged
    // entity's skip id or the indicator latches onto the point being moved.
    const lone: Sketch = { lineA: { start: [0, 0], end: [1, 0] } }
    useSketchEditorStore.setState({ drag: vertexDrag('S1') })
    proj.point = { x: 1, y: 0, z: 0 }
    render(<DragPlane featureId="S1" sketch={lone} sketchGroupRef={groupRef} />)

    move(500, 500)

    expect(useSketchEditorStore.getState().dragSnap).toBeNull()
  })

  it('does not snap to a coincident partner that moves with the dragged vertex', () => {
    // lineA:end is bonded to lineB:start by a coincident constraint; the partner
    // sits on the cursor but is carried along by the solve, so it must not be a
    // snap target.
    const bonded: Sketch = {
      lineA: { start: [100, 100], end: [1, 0] },
      lineB: { start: [1, 0], end: [-100, -100] },
    }
    const constraints = [{ kind: 'coincident', a: '$lineAend', b: '$lineBstart' }]
    useSketchEditorStore.setState({ drag: vertexDrag('S1', { vertexKey: 'end' }) })
    proj.point = { x: 1, y: 0, z: 0 }
    render(
      <DragPlane featureId="S1" sketch={bonded} constraints={constraints as never} sketchGroupRef={groupRef} />,
    )

    move(500, 500)

    // The partner point is not offered, so the point snap loses to the path
    // snap of the curve it sits on rather than latching onto the moving handle.
    const snap = useSketchEditorStore.getState().dragSnap
    expect(snap?.vertexId).toBeUndefined()
    expect(snap?.kind).toBe('entity')
  })
})

describe('DragPlane pointer-up commit', () => {
  it('commits a dimension label drag as the anchor-relative offset', () => {
    const onMutation = vi.fn()
    setSketchCallback('onMutation', onMutation)
    useSketchEditorStore.setState({ drag: dimDrag('S1'), isPointerDown: true })
    render(<DragPlane featureId="S1" sketchGroupRef={groupRef} />)

    up(100, 100)

    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_constraint_pos', featureId: 'S1', constraintId: 'c1', pos: [3, 4],
    })
    const s = useSketchEditorStore.getState()
    expect(s.drag).toBeNull()
    expect(s.dragSnap).toBeNull()
  })

  it('does not commit a dimension label drag that never left the anchor', () => {
    const onMutation = vi.fn()
    setSketchCallback('onMutation', onMutation)
    useSketchEditorStore.setState({
      drag: dimDrag('S1', { currentWorld: [0.00001, 0] }), isPointerDown: true,
    })
    render(<DragPlane featureId="S1" sketchGroupRef={groupRef} />)

    up(100, 100)

    expect(onMutation).not.toHaveBeenCalled()
    expect(useSketchEditorStore.getState().drag).toBeNull()
  })

  it('clears a pending press that never became a drag', () => {
    useSketchEditorStore.setState({
      dragPending: vertexPending('S1'), dragStartClient: [100, 100], isPointerDown: true,
    })
    render(<DragPlane featureId="S1" sketchGroupRef={groupRef} />)

    up(100, 100)

    const s = useSketchEditorStore.getState()
    expect(s.dragPending).toBeNull()
    expect(s.dragStartClient).toBeNull()
    expect(s.isPointerDown).toBe(false)
  })

  it('leaves another sketch\'s drag intact on release', () => {
    useSketchEditorStore.setState({ drag: vertexDrag('S2'), isPointerDown: true })
    render(<DragPlane featureId="S1" sketchGroupRef={groupRef} />)

    up(100, 100)

    expect(useSketchEditorStore.getState().drag).not.toBeNull()
    expect(useSketchEditorStore.getState().drag!.featureId).toBe('S2')
  })

  it('commits an activated vertex drag through the drag tool as a move_vertex', () => {
    const onMutation = vi.fn()
    setSketchCallback('onMutation', onMutation)
    useSketchEditorStore.setState({
      drag: vertexDrag('S1', { startClient: [100, 100], currentWorld: [5, 6] }),
      dragPending: vertexPending('S1'),
      dragStartClient: [100, 100],
      isPointerDown: true,
    })
    render(<DragPlane featureId="S1" sketchGroupRef={groupRef} />)

    up(120, 120)

    expect(onMutation).toHaveBeenCalledWith(expect.objectContaining({
      type: 'move_vertex', featureId: 'S1', entityId: 'lineA', vertexKey: 'start', to: [5, 6],
    }))
    expect(useSketchEditorStore.getState().drag).toBeNull()
  })
})
