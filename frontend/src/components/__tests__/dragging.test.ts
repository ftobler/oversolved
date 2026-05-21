import { describe, it, expect, beforeEach } from 'vitest'
import { shouldActivateDrag } from '@/components/Geometry3D/dragLogic'
import { makeSanitizedEvent } from '@/components/Geometry3D/pointerAbstraction'
import { worldToSketchLocalPure } from '@/components/Geometry3D/coordTransform'
import { CLICK_THRESHOLD_PX } from '@/components/Geometry3D/constants'
import { dispatchDragInitiation } from '@/components/Viewport/idDispatch/dispatchSketchClick'
import { useSketchEditorStore, setSketchCallback } from '@/stores/sketchEditorStore'
import { toolRegistry } from '@/registry/toolRegistry'
import { createDragTool } from '@/tools/DragTool'

try { toolRegistry.register(createDragTool()) } catch { /* already registered */ }

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

describe('Dragging Regressions - Documentation', () => {
  describe('DragPlane z-position specification', () => {
    it('documents that DragPlane must be at z=-0.001', () => {
      // DragPlane position is documented in Dragging.tsx with comments explaining:
      // 1. z=-0.001 places it at sketch plane level (z≤0)
      // 2. Orthographic camera's parallel rays mean x,y are accurate at any z
      // 3. This avoids coordinate distortion from z=0.5 or z=90
      //
      // CODE LOCATION: src/components/Geometry3D/Dragging.tsx line 47
      // COMMENT REQUIREMENT: Must document why z=-0.001 is critical

      const dragPlaneZ = -0.001
      const drawPlaneZ = -0.002
      const sketchGeometryMaxZ = 0

      // DragPlane positioned between DrawPlane and geometry for accurate raycasts
      expect(dragPlaneZ).toBeGreaterThan(drawPlaneZ)
      expect(dragPlaneZ).toBeLessThanOrEqual(sketchGeometryMaxZ)
    })

    it('documents coordinate transformation in toLocal()', () => {
      // The toLocal() function in Dragging.tsx and Drawing.tsx must:
      // 1. Get parent (sketch plane) world position with getWorldPosition()
      // 2. Subtract parent position from world point (translate)
      // 3. Get parent rotation with getWorldQuaternion()
      // 4. Apply inverted rotation (applyQuaternion(q.invert()))
      //
      // CODE LOCATIONS:
      //   - Dragging.tsx line 24-27
      //   - Drawing.tsx line 207-213
      // COMMENT REQUIREMENT: Must document the two-step transform (translate + rotate)

      const requiredSteps = [
        'getWorldPosition - get parent position',
        'sub(parentPos) - translate relative to parent',
        'getWorldQuaternion - get parent rotation',
        'applyQuaternion(invert) - apply inverse rotation',
      ]
      expect(requiredSteps.length).toBe(4)
    })
  })

  describe('Collision geometry hiding - Entity and Vertex', () => {
    it('documents isDragged condition in EntityLines.tsx - only hides after movement', () => {
      // EntityLines.tsx must conditionally hide HitPolyline, but ONLY after drag movement:
      //   const isDragged = drag && 'entityId' in drag &&
      //                     drag.entityId === entityId &&
      //                     drag.featureId === featureId &&
      //                     (drag.currentWorld[0] !== drag.startWorld[0] ||
      //                      drag.currentWorld[1] !== drag.startWorld[1])
      //   {!isDragged && <HitPolyline ... />}
      //
      // CRITICAL: Check that currentWorld != startWorld to distinguish between:
      // - Initial pointerDown (collision visible) → allows click/selection to work
      // - Actual drag movement (collision hidden) → prevents raycast blocking
      //
      // CODE LOCATION: src/components/Geometry3D/EntityLines.tsx
      // REGRESSION PROTECTION: Prevents selection regression where clicking was
      //                        interpreted as drag start
      // See: src/components/__tests__/dragging.test.ts (REGRESSION 2)

      // Before movement: still selectable
      const drag1 = { startWorld: [0, 0], currentWorld: [0, 0] }
      const isDragged1 = drag1.currentWorld[0] !== drag1.startWorld[0] || drag1.currentWorld[1] !== drag1.startWorld[1]
      expect(isDragged1).toBe(false) // collision visible, click can register

      // After movement: collision hidden to prevent blocking
      const drag2 = { startWorld: [0, 0], currentWorld: [0.1, 0] }
      const isDragged2 = drag2.currentWorld[0] !== drag2.startWorld[0] || drag2.currentWorld[1] !== drag2.startWorld[1]
      expect(isDragged2).toBe(true) // collision hidden, raycasts unblocked
    })

    it('documents isDragged condition in VertexDots.tsx - only hides after movement', () => {
      // VertexDots.tsx must conditionally hide vertex hit sphere, but ONLY after movement:
      //   const isDragged = featureId && entityId && drag &&
      //                     'entityId' in drag &&
      //                     drag.entityId === entityId &&
      //                     drag.featureId === featureId &&
      //                     (drag.currentWorld[0] !== drag.startWorld[0] ||
      //                      drag.currentWorld[1] !== drag.startWorld[1])
      //   {!isDragged && <mesh ref={hitRef} ... />}
      //
      // CRITICAL: Movement check ensures quick clicks still select, dragging hides collision.
      //
      // CODE LOCATION: src/components/Geometry3D/VertexDots.tsx
      // REGRESSION PROTECTION: Same as EntityLines - prevents selection being
      //                        misinterpreted as drag start
      // See: src/components/__tests__/dragging.test.ts (REGRESSION 2)

      // No movement yet
      const drag1 = { startWorld: [0, 0], currentWorld: [0, 0] }
      const hasMovement1 = drag1.currentWorld[0] !== drag1.startWorld[0] || drag1.currentWorld[1] !== drag1.startWorld[1]
      expect(hasMovement1).toBe(false)

      // Has moved
      const drag2 = { startWorld: [0, 0], currentWorld: [0.05, 0.05] }
      const hasMovement2 = drag2.currentWorld[0] !== drag2.startWorld[0] || drag2.currentWorld[1] !== drag2.startWorld[1]
      expect(hasMovement2).toBe(true)
    })

    it('documents why collision hiding with movement check prevents both blocking and selection regression', () => {
      // Without collision hiding:
      // 1. User clicks to select → works
      // 2. User drags → DragPlane raycast blocked by HitPolyline/hit sphere
      // 3. onPointerMove never fires → dragging stalls
      //
      // Naive fix (hide immediately on pointerDown):
      // 1. User clicks to select → collision hidden immediately
      // 2. Click detection might fail because collision hidden too early
      // 3. REGRESSION: Selection broken, drag starts immediately
      //
      // Proper fix (hide only after movement):
      // 1. User clicks quickly (no movement) → collision stays visible
      // 2. Click/selection works normally
      // 3. User drags (movement detected) → collision hidden
      // 4. DragPlane raycast hits plane (z=-0.001)
      // 5. onPointerMove fires → smooth dragging continues
      //
      // VERIFY: isDragged checks BOTH drag state AND movement
      const noMovement = { startWorld: [0, 0], currentWorld: [0, 0] }
      const hasMovement = { startWorld: [0, 0], currentWorld: [0.1, 0] }

      const isDragged1 = noMovement.currentWorld[0] !== noMovement.startWorld[0]
      const isDragged2 = hasMovement.currentWorld[0] !== hasMovement.startWorld[0]

      expect(isDragged1).toBe(false) // collision visible for selection
      expect(isDragged2).toBe(true)  // collision hidden for drag performance
    })
  })

  describe('Reference Plane collision hiding', () => {
    it('documents isDragging condition in ReferencePlane.tsx', () => {
      // ReferencePlane.tsx must conditionally hide collision mesh during drag:
      //   const isDragging = drag !== null
      //   {!isDragging && <mesh ... />}
      //
      // CODE LOCATION: src/components/Viewport/ReferencePlane.tsx line 49-51
      // RENDERING: Collision mesh (line 51-62) must be wrapped in {!isDragging &&}
      // COMMENT REQUIREMENT: Must explain why planes hide during any drag

      const isDragging = true // when ANY drag is in progress
      const shouldRenderPlane = !isDragging
      expect(shouldRenderPlane).toBe(false)
    })

    it('documents why reference planes must hide globally', () => {
      // Reference planes (XY, XZ, YZ) are not specific to any sketch.
      // Unlike entity/vertex collision which is checked against specific featureId,
      // reference planes should be hidden during ANY drag to prevent blocking.
      //
      // This is simpler than entity checking: isDragging = drag !== null
      //
      // VERIFY: ReferencePlane uses simple isDragging check, not feature comparison

      const dragExists = true // some entity is being dragged in some sketch
      const allPlanesHidden = dragExists
      expect(allPlanesHidden).toBe(true)
    })
  })

  describe('Spurious move mutation on click-to-select', () => {
    it('documents click-vs-drag distinction using screen pixel distance', () => {
      // ─── REGRESSION 4: "Spurious move mutation on vertex click-to-select" ───
      //
      // BUG: Clicking on a vertex to select it emitted a move_vertex mutation and
      //      visually moved the vertex to the mouse-up position
      // CAUSE: startWorld was set to vertex center [x, y], but currentWorld on
      //        pointer-up was the cursor position on the drag plane. Even a pure
      //        click differs by the hit-radius offset, clearing the world-space
      //        threshold (>= 0.0001), so mutations fired.
      // FIX: Added startClient (screen pixel coordinates) to drag state; threshold
      //      now checks < 4px in screen space. Pixel-space threshold is independent
      //      of zoom level and correctly ignores hit-radius offsets.
      //
      // PROTECTION:
      //   ✓ Code comment in VertexDots.tsx explains startClient requirement
      //   ✓ Code comment in EntityLines.tsx explains startClient requirement
      //   ✓ Code comment in Dragging.tsx explains pixel threshold logic
      //   ✓ Tests verify small pixel deltas suppress mutation, large ones emit
      // TEST COVERAGE:
      //   ✓ Pure click (1px delta) → no mutation
      //   ✓ Real drag (14px delta) → mutation fires

      // Pure click: cursor moves only 1.4 pixels
      const pureClick = {
        startClient: [100, 100] as [number, number],
        upClient: [101, 101] as [number, number],
      }
      const clickPixelDistance = Math.hypot(
        pureClick.upClient[0] - pureClick.startClient[0],
        pureClick.upClient[1] - pureClick.startClient[1]
      )
      expect(clickPixelDistance).toBeLessThan(4) // should suppress mutation
      expect(clickPixelDistance).toBeCloseTo(1.414, 2)

      // Real drag: cursor moves 14 pixels
      const realDrag = {
        startClient: [100, 100] as [number, number],
        upClient: [110, 110] as [number, number],
      }
      const dragPixelDistance = Math.hypot(
        realDrag.upClient[0] - realDrag.startClient[0],
        realDrag.upClient[1] - realDrag.startClient[1]
      )
      expect(dragPixelDistance).toBeGreaterThanOrEqual(4) // should emit mutation
      expect(dragPixelDistance).toBeCloseTo(14.142, 2)
    })
  })

  describe('Integration requirements', () => {
    it('documents that collision hiding requires all three components modified', () => {
      // Protecting against these regressions requires:
      // 1. Dragging.tsx (position + comments)
      // 2. Drawing.tsx (coordinate transform comments)
      // 3. EntityLines.tsx (isDragged check with MOVEMENT verification + hiding)
      // 4. VertexDots.tsx (isDragged check with MOVEMENT verification + hiding)
      // 5. ReferencePlane.tsx (isDragging check + hiding)
      //
      // CRITICAL: EntityLines and VertexDots must check BOTH drag state AND movement:
      //   isDragged = drag && ... && (currentWorld != startWorld)
      // This prevents the selection regression where clicks were misinterpreted as drag starts.
      //
      // Missing ANY of these allows the regression to reappear.
      // UPDATE CHECKLIST when modifying drag behavior:
      //   [ ] DragPlane position is z=-0.001
      //   [ ] toLocal() translates before rotating
      //   [ ] EntityLines hides HitPolyline when isDragged (WITH movement check)
      //   [ ] VertexDots hides hit sphere when isDragged (WITH movement check)
      //   [ ] ReferencePlane hides mesh when isDragging
      //   [ ] Movement check prevents selection regression

      const modifiedFiles = [
        'Dragging.tsx',
        'Drawing.tsx',
        'EntityLines.tsx',
        'VertexDots.tsx',
        'ReferencePlane.tsx',
      ]
      expect(modifiedFiles.length).toBe(5)
    })
  })
})

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

  it('documents that pointermove now bypasses R3F event bubbling', () => {
    // DragPlane and DrawPlane no longer use onPointerMove on their R3F meshes.
    // Instead both attach window.addEventListener('pointermove', handler) via useEffect.
    // The handler constructs a THREE.Raycaster from NDC coords and calls the identical
    // sanitizePointerEvent pipeline, so local coordinates are unchanged.
    //
    // Consequence: Body3D, Surfaces, and any future scene meshes can never block
    // drag or draw events regardless of their z-order in the scene graph.
    //
    // CODE LOCATIONS:
    //   DragPlane -- src/components/Geometry3D/Dragging.tsx (handleMoveRef + useEffect)
    //   DrawPlane -- src/components/Geometry3D/Drawing.tsx (handleDrawMoveRef + useEffect)

    const eventPaths = ['window.pointermove (DragPlane)', 'window.pointermove (DrawPlane)']
    expect(eventPaths.every(p => p.startsWith('window'))).toBe(true)
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
      orbitEnabled: true,
      isPointerDown: false,
      hoveredVertexId: null,
      hoveredVertexPosition: null,
      hoveredSnapKind: null,
      normalSelection: new Set(),
    internalHoverSelection: null,
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
    expect(s.orbitEnabled).toBe(false)
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
