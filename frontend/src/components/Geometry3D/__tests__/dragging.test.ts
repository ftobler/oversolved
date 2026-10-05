import { describe, it, expect, beforeEach } from 'vitest'
import { shouldActivateDrag } from '@/components/Geometry3D/dragLogic'
import { makeSanitizedEvent } from '@/components/Geometry3D/pointerAbstraction'
import { worldToSketchLocalPure } from '@/components/Geometry3D/coordTransform'
import { CLICK_THRESHOLD_PX } from '@/components/Geometry3D/constants'
import { dispatchDragInitiation } from '@/components/Viewport/idDispatch/dispatchSketchClick'
import { useSketchEditorStore, setSketchCallback } from '@/stores/sketchEditorStore'
import { toolRegistry } from '@/registry/toolRegistry'
import { initializeTools } from '@/tools'

beforeEach(() => {
  toolRegistry.reset()
  initializeTools()
})

// Dragging is a math-plane gesture now: the cursor is projected onto the sketch
// plane with no scene mesh, so there is no DragPlane mesh and no z=-0.001
// placement to protect. The drag-plane recipe is pinned by
// mathPlaneDrag.test.ts; the absence of a drag mesh by noDragPlaneMeshes.test.ts.
// What remains here is the pixel threshold: movement below CLICK_THRESHOLD_PX is
// a click (selection), at or above it starts a drag.

describe('shouldActivateDrag -- threshold math', () => {
  it('returns false when movement is exactly zero', () => {
    expect(shouldActivateDrag([100, 100], [100, 100])).toBe(false)
  })

  it('returns false when movement is just below threshold', () => {
    // Moving 3.99px diagonally falls under CLICK_THRESHOLD_PX (4)
    const delta = (CLICK_THRESHOLD_PX - 0.01) / Math.SQRT2
    expect(shouldActivateDrag([0, 0], [delta, delta])).toBe(false)
  })

  it('returns true when movement equals threshold exactly', () => {
    expect(shouldActivateDrag([0, 0], [CLICK_THRESHOLD_PX, 0])).toBe(true)
  })

  it('returns true when movement exceeds threshold', () => {
    expect(shouldActivateDrag([100, 200], [115, 200])).toBe(true)
  })

  it('is symmetric -- start and current order does not matter', () => {
    expect(shouldActivateDrag([0, 0], [10, 0])).toBe(shouldActivateDrag([10, 0], [0, 0]))
  })
})

describe('makeSanitizedEvent -- off-plane rejection and coordinate wrapping', () => {
  it('returns null when |z| > 1 (off-plane hit)', () => {
    expect(makeSanitizedEvent([1, 2, 1.5], [300, 400])).toBeNull()
    expect(makeSanitizedEvent([1, 2, -2], [300, 400])).toBeNull()
  })

  it('accepts hits exactly on the boundary |z| = 1', () => {
    expect(makeSanitizedEvent([1, 2, 1], [300, 400])).not.toBeNull()
    expect(makeSanitizedEvent([1, 2, -1], [300, 400])).not.toBeNull()
  })

  it('returns the xy sketch-local point and the client pixel coords', () => {
    const result = makeSanitizedEvent([3.5, -1.2, 0.001], [640, 480])
    expect(result).not.toBeNull()
    expect(result!.localPoint).toEqual([3.5, -1.2])
    expect(result!.clientPoint).toEqual([640, 480])
  })

  it('returns null for exactly |z| slightly above 1', () => {
    expect(makeSanitizedEvent([0, 0, 1.001], [0, 0])).toBeNull()
  })
})

describe('Window listener vs R3F path -- coordinate equivalence', () => {
  it('worldToSketchLocalPure produces identical output for both event paths', () => {
    // Both paths (window listener and former R3F onPointerMove) call the same
    // sanitizePointerEvent -> worldToLocal3D -> worldToSketchLocalPure pipeline.
    // This test verifies worldToSketchLocalPure is deterministic given the same inputs,
    // so the two paths are coordinate-equivalent by construction.

    // Sketch group at world position (1, 2, 3), no rotation (identity quaternion).
    const parentPos: [number, number, number] = [1, 2, 3]
    const identity: [number, number, number, number] = [0, 0, 0, 1]

    const worldPt: [number, number, number] = [4, 7, 3]
    const local = worldToSketchLocalPure(worldPt, parentPos, identity)

    // With identity quaternion the result is just translation: [4-1, 7-2, 3-3] = [3, 5, 0]
    expect(local[0]).toBeCloseTo(3)
    expect(local[1]).toBeCloseTo(5)
    expect(local[2]).toBeCloseTo(0)
  })

  it('worldToSketchLocalPure correctly inverts a 90-degree rotation around Z', () => {
    // Sketch plane rotated 90 degrees CCW around the world Z axis.
    // A world-space X displacement should appear as a local Y displacement.
    const parentPos: [number, number, number] = [0, 0, 0]
    // quaternion for 90 deg around Z: [0, 0, sin(45deg), cos(45deg)]
    const s = Math.sin(Math.PI / 4)
    const c = Math.cos(Math.PI / 4)
    const q90z: [number, number, number, number] = [0, 0, s, c]

    // A point 1 unit in world X should map to -1 local Y after inverse rotation.
    const worldPt: [number, number, number] = [1, 0, 0]
    const local = worldToSketchLocalPure(worldPt, parentPos, q90z)

    expect(local[0]).toBeCloseTo(0, 5)   // local x
    expect(local[1]).toBeCloseTo(-1, 5)  // local y
    expect(local[2]).toBeCloseTo(0, 5)   // on-plane
  })

})

describe('dispatchDragInitiation integration', () => {
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

  it('full drag flow via dispatchDragInitiation with activeTool=null', () => {
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
      expect(s.dragPending!.featureId).toBe('feat1')
      expect(s.dragPending!.entityId).toBe('line1')
      expect(s.dragPending!.vertexKey).toBe('start')
    }
  })
})
