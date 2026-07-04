// Architectural rule test (feature/drag-topology-staleness.md): while the
// topology is stale relative to what is rendered, the snap candidate set
// contains NO `isect:` ids (free curve-curve intersections are pre-drag
// positions), so a drag-then-auto-insert-constraint cannot commit a coincident
// against a crossing that has moved. The `dock:` half (tangent contacts) stays
// live during a drag because `sketchToDockCandidates` derives from the live
// `sketch + constraints + params`, never from topology.
//
// This test does NOT mock the DOM; it just exercises the pure snapDetection
// functions under two inputs: stale topology (undefined) and fresh topology.
import { describe, it, expect } from 'vitest'
import type { Sketch, PartConstraint, Topology } from '@/types/cad'
import { inferredContactCandidates, sketchToIntersectionCandidates } from '@/components/Geometry3D/snapDetection'
import { topologyStale } from '@/components/Geometry3D/dragTopologyGate'

const FEATURE = 'S1'

// A line crossing a circle -- the area builder emits a curve-curve
// intersection the inferred-contact set would offer as a `isect:` snap target.
const sketchCrossing = (): Sketch => ({
  L1: { start: [-10, 0], end: [10, 0] } as Sketch[string],
  C1: { center: [0, 0], radius: 5 } as Sketch[string],
})

const topologyWithIntersection = (x: number, y: number): Topology => ({
  intersection_points: {
    x0: { x, y },
  },
  vertices: {},
  edges: [],
  surfaces: [],
})

describe('snap-scan topology gate -- stale topology must drop isect: candidates', () => {
  it('fresh topology offers the free crossing as an isect: candidate', () => {
    const cands = inferredContactCandidates(
      sketchCrossing(), FEATURE, [], topologyWithIntersection(5, 0), 'active_sketch',
    )
    expect(cands.some(c => c.id.startsWith('isect:'))).toBe(true)
  })

  it('topology = undefined yields zero isect: candidates (the gate)', () => {
    const cands = inferredContactCandidates(
      sketchCrossing(), FEATURE, [], undefined, 'active_sketch',
    )
    expect(cands.every(c => !c.id.startsWith('isect:'))).toBe(true)
  })

  it('sketchToIntersectionCandidates returns [] for undefined topology', () => {
    expect(
      sketchToIntersectionCandidates(sketchCrossing(), undefined, FEATURE, 'active_sketch'),
    ).toEqual([])
  })
})

describe('snap-scan topology gate -- dock: candidates survive the gate (live-derived)', () => {
  const sketchTangent = (): Sketch => ({
    circA: { center: [0, 0], radius: 5 } as Sketch[string],
    circB: { center: [10, 0], radius: 5 } as Sketch[string],
  })
  const tangent: PartConstraint[] = [{ id: 'tan', kind: 'tangent', a: '$circA', b: '$circB' }]

  it('dock: contact offered with topology (informational)', () => {
    const cands = inferredContactCandidates(
      sketchTangent(), FEATURE, tangent, topologyWithIntersection(5, 0), 'active_sketch',
    )
    expect(cands.some(c => c.id.startsWith('dock:'))).toBe(true)
  })

  it('dock: contact STILL offered with topology = undefined (gate does not starve dock snaps)', () => {
    const cands = inferredContactCandidates(
      sketchTangent(), FEATURE, tangent, undefined, 'active_sketch',
    )
    expect(cands.some(c => c.id.startsWith('dock:'))).toBe(true)
  })
})

describe('architectural pin: while `topologyStale` is true the snap set has no `isect:` ids', () => {
  // The rule: the render gate and the snap gate read the SAME selector, so a
  // render-suppression bug cannot leave stale isect: candidates on for snaps.
  // Property: for any (isDraggingThis, nextHeld, solved) where topologyStale
  // returns true, inferredContactCandidates(..., undefined, ...) contains no
  // isect: ids.
  const cases: Array<{ name: string; isDraggingThis: boolean; nextHeld: Sketch | null; solved: Sketch }> = [
    { name: 'dragging', isDraggingThis: true, nextHeld: null, solved: {} as Sketch },
    { name: 'held-preview (post-drag pre-solve)', isDraggingThis: false, nextHeld: {} as Sketch, solved: {} as Sketch },
  ]

  for (const c of cases) {
    it(`${c.name}: stale=true, snap set has no isect: ids`, () => {
      expect(topologyStale(c.isDraggingThis, c.nextHeld, c.solved)).toBe(true)
      const cands = inferredContactCandidates(
        sketchCrossing(), FEATURE, [], undefined, 'active_sketch',
      )
      // The invariant: this assertion holds ONLY because the production caller
      // passes topology=undefined while stale. Should the caller ever forget,
      // the snap scan would re-emit isect: ids at the pre-drag crossing.
      expect(cands.every(c => !c.id.startsWith('isect:'))).toBe(true)
    })
  }
})