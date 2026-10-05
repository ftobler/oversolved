import { describe, it, expect } from 'vitest'
import type { Sketch, PartConstraint } from '@/types/cad'
import { sketchToDockCandidates, findSnapTarget, sketchToEntityCandidates, inferredContactCandidates } from '@/components/Geometry3D/snapDetection'
import { computeDragMutation } from '@/components/Geometry3D/dragLogic'
import { InferredContactMarkers } from '@/components/Geometry3D/InferredContactMarkers'
import type { VertexOrEdgeDrag } from '@/stores/sketchEditorStore'

const FEATURE = 'S1'

// Two circles externally tangent at (5, 0), held by a tangent constraint.
const makeSketch = (): Sketch => ({
  circA: { center: [0, 0], radius: 5 } as Sketch[string],
  circB: { center: [10, 0], radius: 5 } as Sketch[string],
})
const tangent: PartConstraint[] = [{ id: 'tan', kind: 'tangent', a: '$circA', b: '$circB' }]

describe('sketchToDockCandidates', () => {
  it('offers the tangent contact as a dock-handle snap candidate', () => {
    const cands = sketchToDockCandidates(makeSketch(), FEATURE, tangent, 'active_sketch')
    expect(cands).toHaveLength(1)
    expect(cands[0].id).toBe('dock:S1:tan')
    expect(cands[0].kind).toBe('vertex')
    expect(cands[0].position[0]).toBeCloseTo(5, 9)
    expect(cands[0].position[1]).toBeCloseTo(0, 9)
  })

  it('omits a contact already materialized (a dock names the host)', () => {
    const docked: PartConstraint[] = [
      ...tangent,
      { id: 'dk', kind: 'dock', point: '$ptxy', host: 'tan' },
    ]
    expect(sketchToDockCandidates(makeSketch(), FEATURE, docked, 'active_sketch')).toHaveLength(0)
  })

  it('emits nothing when there is no dockable host', () => {
    expect(sketchToDockCandidates(makeSketch(), FEATURE, [], 'active_sketch')).toHaveLength(0)
  })
})

/**
 * The solved geometry of `bugreports/bug-report-1788207174415.md`: one line
 * tangent to two circles with BOTH its endpoints constrained coincident on
 * them. Every tangent contact here is already a real point.
 */
const tangentLineSketch = (): Sketch => ({
  circA: { center: [-4.353449892247063e-12, -4.043118964625059e-11], radius: 9.5 },
  circB: { center: [1.524140952335884e-10, 10], radius: 4 },
  line: {
    start: [3.340658664703369, 12.199999809265137],
    end: [7.9340643882751465, 5.224999904632568],
  },
} as unknown as Sketch)

const tangentLineConstraints: PartConstraint[] = [
  { id: 'cS', kind: 'coincident', a: '$linestart', b: '$circB' },
  { id: 'cE', kind: 'coincident', a: '$lineend', b: '$circA' },
  { id: 'tanB', kind: 'tangent', a: '$line', b: '$circB' },
  { id: 'tanA', kind: 'tangent', a: '$line', b: '$circA' },
]

describe('inferredContactCandidates and contacts a real point already occupies', () => {
  it('offers no dock where a coincident endpoint is already the tangent point', () => {
    // A `dock` constraint is not the only way a contact becomes real. An endpoint
    // constrained coincident on the circle its line is tangent to IS the tangent
    // point, so the handle was a ring drawn over a point that was already there,
    // inviting a second point on top of the first -- and, being appended after
    // the real vertices into one THREE.Points, it took the endpoint's ID pixel
    // with it.
    const cands = inferredContactCandidates(
      tangentLineSketch(), FEATURE, tangentLineConstraints, undefined, 'active_sketch')
    expect(cands).toEqual([])
  })

  it('still offers the dock when nothing real sits on the contact', () => {
    // The circle-circle tangency: the contact is on neither circle's centre, so
    // no vertex covers it and the handle is the only way to reach it.
    const cands = inferredContactCandidates(
      makeSketch(), FEATURE, tangent, undefined, 'active_sketch')
    expect(cands.map(c => c.id)).toEqual(['dock:S1:tan'])
  })

  it('does not withdraw the dock for a real point merely near the contact', () => {
    // The rule is "a point is already there", not "a point is nearby": a free
    // point a visible distance away must not silently remove the handle.
    const sketch = makeSketch()
    sketch.free = { x: 5, y: 0.5 } as Sketch[string]
    const cands = inferredContactCandidates(sketch, FEATURE, tangent, undefined, 'active_sketch')
    expect(cands.map(c => c.id)).toEqual(['dock:S1:tan'])
  })
})

describe('drag-snap to a dock contact yields a materializing constraint', () => {
  it('snapping near the contact produces move_vertex_with_constraint carrying the dock handle', () => {
    const dockCands = sketchToDockCandidates(makeSketch(), FEATURE, tangent, 'active_sketch')
    const entityCands = sketchToEntityCandidates(makeSketch(), FEATURE, 'active_sketch')
    // Cursor a hair off the contact at (5,0); generous vertex threshold.
    const snap = findSnapTarget(dockCands, entityCands, 'vertex', 5.05, 0.05, 1.0, 0.0)
    expect(snap).not.toBeNull()
    expect(snap!.kind).toBe('vertex')
    expect(snap!.vertexId).toBe('dock:S1:tan')
    expect(snap!.constraintKind).toBe('coincident')

    const drag: VertexOrEdgeDrag = {
      type: 'vertex',
      featureId: FEATURE,
      entityId: 'free',
      vertexKey: 'xy',
      startWorld: [9, 9],
      currentWorld: [5, 0],
      startClient: [0, 0],
    } as VertexOrEdgeDrag
    const mut = computeDragMutation([200, 200], drag, snap, null)
    expect(mut?.type).toBe('move_vertex_with_constraint')
    // The snap handle rides through to the mutation, where applyAddConstraint
    // intercepts it and materializes the point.
    expect((mut as { snapVertexId?: string }).snapVertexId).toBe('dock:S1:tan')
    expect((mut as { constraintKind?: string }).constraintKind).toBe('coincident')
  })
})

describe('InferredContactMarkers render decision', () => {
  it('renders nothing without any inferred contact', () => {
    expect(InferredContactMarkers({ candidates: [] })).toBeNull()
    const none = inferredContactCandidates(makeSketch(), FEATURE, [], undefined, 'active_sketch')
    expect(InferredContactMarkers({ candidates: none })).toBeNull()
  })

  it('renders a marker tree when a tangent contact exists', () => {
    const candidates = inferredContactCandidates(makeSketch(), FEATURE, tangent, undefined, 'active_sketch')
    expect(candidates.length).toBeGreaterThan(0)
    expect(InferredContactMarkers({ candidates })).not.toBeNull()
  })
})
