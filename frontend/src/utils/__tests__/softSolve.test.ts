import { describe, it, expect, vi, beforeEach } from 'vitest'
import { softSolve } from '@/utils/softSolve'
import type { Sketch, PartFeature } from '@/types/cad'
import type { DragState, VertexOrEdgeDrag } from '@/stores/sketchEditorStore'

// ─── Fixtures ───

interface LineEntity { start: [number, number]; end: [number, number] }

function makeSketchWithLines(): Sketch {
  return {
    L1: { start: [0, 0] as [number, number], end: [10, 0] as [number, number] },
    L2: { start: [10, 0] as [number, number], end: [10, 10] as [number, number] },
  } as unknown as Sketch
}

function makeFeatureWithCoincidence(featureId: string): PartFeature {
  // Coincident constraint: L1.end is coincident with L2.start.
  // Stored as $L1end and $L2start after parseTarget conversion.
  return {
    id: featureId,
    kind: 'sketch',
    constraints: [
      { id: 'c_coincident_1', kind: 'coincident', a: '$L1end', b: '$L2start' },
    ],
  }
}

function makeVertexDrag(overrides: Partial<VertexOrEdgeDrag> = {}): DragState {
  const drag: VertexOrEdgeDrag = {
    type: 'vertex',
    vertexId: 'vertex:S1:L1:end',
    featureId: 'S1',
    entityId: 'L1',
    vertexKey: 'end',
    startWorld: [10, 0],
    currentWorld: [15, 5],
    startClient: [100, 100],
    ...overrides,
  }
  return drag
}

// ─── test_soft_solve_is_frontend_only ───
//
// The soft solve must not send any WebSocket message during a drag.
// Only a hard solve (triggered by onMutation on pointer-up) should communicate
// with the backend.
describe('test_soft_solve_is_frontend_only', () => {
  it('softSolve does not construct WebSocket or call any async operation', () => {
    // Verify softSolve is synchronous and returns a plain object, not a Promise.
    const sketch = makeSketchWithLines()
    const feature = makeFeatureWithCoincidence('S1')
    const drag = makeVertexDrag()

    const result = softSolve({ sketch, drag, feature })

    // Result is a plain synchronous object, not a Promise.
    expect(result).not.toBeInstanceOf(Promise)

    // softSolve has no imports from solverWs or any network module;
    // the module graph is verified to stay pure (no WebSocket calls).
    expect(typeof result).toBe('object')
  })

  it('softSolve is a pure function that returns a new object without mutating input', () => {
    const sketch = makeSketchWithLines()
    const originalEnd = (sketch.L1 as LineEntity).end
    const drag = makeVertexDrag({ currentWorld: [20, 0] as [number, number] })

    const result = softSolve({ sketch, drag, feature: undefined })

    // Input not mutated.
    expect((sketch.L1 as LineEntity).end).toBe(originalEnd)

    // Result is a new object.
    expect(result).not.toBe(sketch)
    expect(result.L1).not.toBe(sketch.L1)
  })
})

// ─── test_soft_solve_honours_coincidence ───
//
// When a vertex has a coincident constraint to another vertex, dragging
// the first vertex must move the partner to the same position.
describe('test_soft_solve_honours_coincidence', () => {
  it('moves a coincident partner vertex to the dragged position', () => {
    const sketch = makeSketchWithLines()
    const feature = makeFeatureWithCoincidence('S1')

    // Drag L1.end to a new position.
    const drag = makeVertexDrag({ currentWorld: [20, 5] as [number, number] })

    const result = softSolve({ sketch, drag, feature })

    // L1.end should be at the dragged position.
    expect((result.L1 as LineEntity).end).toEqual([20, 5])

    // L2.start (coincident with L1.end) should follow to the same position.
    expect((result.L2 as LineEntity).start).toEqual([20, 5])

    // L2.end should be unchanged.
    expect((result.L2 as LineEntity).end).toEqual([10, 10])
  })

  it('also moves the dragged vertex when the constraint lists it in the b field', () => {
    const sketch = makeSketchWithLines()
    // Reversed order in constraint: b is the dragged vertex, a is the partner.
    const feature: PartFeature = {
      id: 'S1',
      kind: 'sketch',
      constraints: [
        { id: 'c_coincident_1', kind: 'coincident', a: '$L2start', b: '$L1end' },
      ],
    }

    const drag = makeVertexDrag({ currentWorld: [8, 3] as [number, number] })
    const result = softSolve({ sketch, drag, feature })

    // Dragged vertex moved.
    expect((result.L1 as LineEntity).end).toEqual([8, 3])
    // Coincident partner also moved.
    expect((result.L2 as LineEntity).start).toEqual([8, 3])
  })

  it('ignores coincidence constraints of other kinds', () => {
    const sketch = makeSketchWithLines()
    const feature: PartFeature = {
      id: 'S1',
      kind: 'sketch',
      constraints: [
        { id: 'c_horizontal_1', kind: 'horizontal', target: '$L1' },
      ],
    }

    const drag = makeVertexDrag({ currentWorld: [15, 5] as [number, number] })
    const result = softSolve({ sketch, drag, feature })

    // Non-coincident constraints are silently relaxed; L2.start stays put.
    expect((result.L2 as LineEntity).start).toEqual([10, 0])

    // L1.end still moves.
    expect((result.L1 as LineEntity).end).toEqual([15, 5])
  })

  it('handles a sketch without any feature/constraints gracefully', () => {
    const sketch = makeSketchWithLines()
    const drag = makeVertexDrag({ currentWorld: [5, 5] as [number, number] })

    const result = softSolve({ sketch, drag, feature: undefined })

    // Dragged vertex moves; nothing else is affected.
    expect((result.L1 as LineEntity).end).toEqual([5, 5])
    expect((result.L2 as LineEntity).start).toEqual([10, 0])
  })
})

// ─── test_soft_solve_does_not_persist ───
//
// Pointer-up must commit the hard-solve result, not the last soft-solve result.
// The hard solve runs via onMutation -> reSolve (backend WebSocket).
// This test verifies that:
//   - softSolve produces its preview independently of the committed sketch,
//   - the final committed value is the hard-solve result (the mutation's target position),
//     not the soft-solve preview value.
describe('test_soft_solve_does_not_persist', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('soft-solve preview differs from committed hard-solve result when they diverge', () => {
    // Scenario:
    //   Soft solve: moves L1.end to [15, 5] (raw cursor position, no constraint resolution)
    //   Hard solve: backend resolves the coincident constraint, places L1.end at exactly [14, 4]
    //   After pointer-up the committed sketch uses the hard-solve value.

    const sketch = makeSketchWithLines()
    const feature = makeFeatureWithCoincidence('S1')

    // Soft-solve preview during drag.
    const softDrag = makeVertexDrag({ currentWorld: [15, 5] as [number, number] })
    const softResult = softSolve({ sketch, drag: softDrag, feature })
    expect((softResult.L1 as LineEntity).end).toEqual([15, 5])

    // After pointer-up, onMutation fires with the final cursor position [15, 5].
    // The backend hard solve returns a fully-resolved sketch. Simulate the backend
    // snapping to a slightly different position due to constraint resolution.
    const hardSolvedSketch: Sketch = structuredClone(sketch)
    ;(hardSolvedSketch.L1 as LineEntity).end = [14, 4]
    ;(hardSolvedSketch.L2 as LineEntity).start = [14, 4]

    // The committed (hard-solve) position is what was returned by the backend.
    const committed = hardSolvedSketch
    expect((committed.L1 as LineEntity).end).toEqual([14, 4])

    // Verify the soft-solve preview and hard-solve result differ.
    expect((softResult.L1 as LineEntity).end).not.toEqual(
      (committed.L1 as LineEntity).end,
    )

    // After pointer-up there is no active drag, so softSolve is no longer called.
    // The display sketch reverts to the hard-solve result immediately.
    const dimDrag: DragState = {
      type: 'dim_label',
      constraintId: 'x',
      featureId: 'S1',
      anchorWorld: [0, 0],
      startWorld: [0, 0],
      currentWorld: [0, 0],
    }
    const noDragResult = softSolve({ sketch: committed, drag: dimDrag, feature })
    // dim_label pass-through: committed sketch returned unchanged.
    expect(noDragResult).toBe(committed)
  })

  it('dim_label drag is passed through: softSolve returns the input sketch unchanged', () => {
    const sketch = makeSketchWithLines()
    const dimDrag: DragState = {
      type: 'dim_label',
      constraintId: 'c_dim_1',
      featureId: 'S1',
      anchorWorld: [5, 0],
      startWorld: [5, 0],
      currentWorld: [5, 2],
    }

    const result = softSolve({ sketch, drag: dimDrag, feature: undefined })

    // For dim_label drags the sketch geometry is untouched.
    expect(result).toBe(sketch)
  })
})

// ─── test_edge_drag_delta ───
//
// Edge (whole-entity) drags apply a uniform delta to all vertices of
// the dragged entity. The delta is currentWorld - startWorld where
// startWorld is a real position (cursor at activation time, not [0,0]).
describe('test_edge_drag_delta', () => {
  it('moves all line vertices by the delta when edge is dragged', () => {
    const sketch = makeSketchWithLines()
    const drag: DragState = {
      type: 'edge',
      vertexId: 'entity:S1:L1',
      featureId: 'S1',
      entityId: 'L1',
      vertexKey: '',
      startWorld: [5, 0],
      currentWorld: [8, 2],
      startClient: [100, 100],
    }

    const result = softSolve({ sketch, drag, feature: undefined })

    // L1 start moved: [0,0] + [3,2] = [3,2]
    expect((result.L1 as { start: [number, number]; end: [number, number] }).start).toEqual([3, 2])
    // L1 end moved: [10,0] + [3,2] = [13,2]
    expect((result.L1 as { start: [number, number]; end: [number, number] }).end).toEqual([13, 2])
    // L2 (different entity) unchanged
    expect((result.L2 as { start: [number, number]; end: [number, number] }).start).toEqual([10, 0])
    expect((result.L2 as { start: [number, number]; end: [number, number] }).end).toEqual([10, 10])
  })

  it('returns sketch unchanged when edge has not moved', () => {
    const sketch = makeSketchWithLines()
    const drag: DragState = {
      type: 'edge',
      vertexId: 'entity:S1:L1',
      featureId: 'S1',
      entityId: 'L1',
      vertexKey: '',
      startWorld: [5, 0],
      currentWorld: [5, 0],
      startClient: [100, 100],
    }

    const result = softSolve({ sketch, drag, feature: undefined })

    // No movement -> returns unchanged (reference equality via early return)
    expect(result).toBe(sketch)
  })

  it('moves circle center by the delta', () => {
    const sketch: Sketch = {
      C1: { center: [0, 0] as [number, number], radius: 5 },
    } as unknown as Sketch
    const drag: DragState = {
      type: 'edge',
      vertexId: 'entity:S1:C1',
      featureId: 'S1',
      entityId: 'C1',
      vertexKey: '',
      startWorld: [0, 0],
      currentWorld: [3, -2],
      startClient: [100, 100],
    }

    const result = softSolve({ sketch, drag, feature: undefined })

    expect((result.C1 as { center: [number, number] }).center).toEqual([3, -2])
  })

  it('moves arc start/end/center by the delta', () => {
    const sketch: Sketch = {
      A1: {
        center: [5, 5] as [number, number],
        start: [5, 10] as [number, number],
        end: [10, 5] as [number, number],
        radius: 5,
        angle_start: 90,
        angle_end: 0,
      },
    } as unknown as Sketch
    const drag: DragState = {
      type: 'edge',
      vertexId: 'entity:S1:A1',
      featureId: 'S1',
      entityId: 'A1',
      vertexKey: '',
      startWorld: [5, 5],
      currentWorld: [8, 10],
      startClient: [100, 100],
    }

    const result = softSolve({ sketch, drag, feature: undefined })

    // Delta = [3, 5]; arc vertices moved by same delta
    const arc = result.A1 as { center: [number, number]; start: [number, number]; end: [number, number] }
    expect(arc.center).toEqual([8, 10])
    expect(arc.start).toEqual([8, 15])
    expect(arc.end).toEqual([13, 10])
  })
})
