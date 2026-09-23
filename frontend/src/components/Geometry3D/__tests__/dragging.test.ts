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

// REGRESSION TEST DOCUMENTATION: Dragging Coordinate and Collision Bugs
//
// These tests document the chain of interdependent fixes for dragging behavior.
// Many regressions are hard to unit test (Three.js raycasting, coordinate distortion)
// and are instead protected by code comments that explain the requirements.
//
// ─── REGRESSION 1: "Drag Coordinate Distortion at Camera Angles" ───
//
// BUG: When camera tilted relative to sketch plane, dragged elements jumped
//      away from cursor (shift direction depended on camera angle)
// CAUSE: DragPlane was at z=0.5 or z=90, far from sketch plane (z=-0.001)
// FIX: Position DragPlane at z=-0.001 (same as sketch plane)
//
// PROTECTION:
//   ✓ Code comment in Dragging.tsx (line 13-20) explains z=-0.001 requirement
//   ✓ Code comment in Dragging.tsx toLocal() (line 24-27) explains coordinate transform
//   ✓ Code comment in Drawing.tsx toLocal() (line 207-213) explains same logic
// TEST COVERAGE:
//   ✓ Manual test: Drag element with tilted camera → element stays under cursor
//
// ─── REGRESSION 2: "Self-Intersection Blocking Dragging" ───
//
// BUG: Dragging became choppy/jittery when element overlapped its own
//      collision geometry (HitPolyline, vertex hit spheres)
// CAUSE: Raycasts to DragPlane were blocked by entity's collision meshes
// FIX: Hide collision geometry during drag, BUT ONLY AFTER MOVEMENT STARTS:
//      - EntityLines.tsx: {!isDragged && <HitPolyline ... />}
//      - VertexDots.tsx: {!isDragged && <mesh ref={hitRef} ... />}
// CRITICAL: isDragged must check BOTH drag state AND movement to prevent
//           regression where clicks couldn't register as selection
//
// SELECTION REGRESSION FIX:
//   Problem: Naive hiding (collision hidden immediately on pointerDown) broke
//            selection, making it hard to click without starting a drag
//   Solution: Only hide collision after movement detected (currentWorld != startWorld)
//             This allows quick clicks to select, but hides during actual dragging
//
// PROTECTION:
//   ✓ Code comment in EntityLines.tsx explains isDragged with movement check
//   ✓ Code comment in VertexDots.tsx explains isDragged with movement check
//   ✓ Tests document why movement check is critical for preventing regression
// TEST COVERAGE:
//   ✓ Manual test: Click to select → works normally
//   ✓ Manual test: Drag element → smooth movement, no jitter
//
// ─── REGRESSION 3: "Reference Planes Blocking Drags" ───
//
// BUG: Dragging failed when cursor moved over reference planes (XY, XZ, YZ)
// CAUSE: ReferencePlane mesh was blocking raycasts to DragPlane
// FIX: Hide ReferencePlane mesh during drag:
//      ReferencePlane.tsx: {!isDragging && <mesh ... />}
//
// PROTECTION:
//   ✓ Code comment in ReferencePlane.tsx (line 49-51) explains isDragging logic
//   ✓ Zustand tests in sketchEditorStore.test.ts verify drag state exists
// TEST COVERAGE:
//   ✓ Manual test: Drag over origin planes → continuous dragging works
//
// ─── NOTE: These regressions are protected by: ───
// 1. Code comments explaining the root cause and fix
// 2. Comments documenting why collision must be hidden
// 3. Manual testing (UI interaction can't be unit tested easily)

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
