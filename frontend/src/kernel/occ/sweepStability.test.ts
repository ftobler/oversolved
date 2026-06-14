// @vitest-environment node
//
// Real-OCC SHAPE-correctness + stability gate for the sweep spine. It drives the
// whole production path (topology Repository -> collectPathEdges -> spine wire ->
// sweepProfileWithLineage) and asserts the swept solid's CENTROID, not just its
// volume. Volume is blind to a mirrored / reversed / wrong-side / tilted arc
// (length is unchanged), which is exactly how a wrong-shape sweep slips past a
// volume check; the centroid pins the actual geometry in space.
//
// Geometry: a 4x4 square profile (area 16) swept along a circular arc of radius
// R=10. Because the profile centroid rides ON the spine, the solid centroid
// equals the arc's own centroid: at distance R*sin(a)/a from the circle centre
// along the span bisector (half-angle a).
//
// Skips when opencascade.js is absent.

import { describe, it, expect } from 'vitest'
import { loadOcc } from './loadOcc'
import { DisposeScope } from './disposeScope'
import { sweepProfileWithLineage } from './prismLineage'
import { collectPathEdges } from '../features/sweep'
import { Repository } from '../query'
import type { PlaneLike } from '../features/shared'
import type { LoopEdge } from '../profileLoops'
import type { OccModule, OccShape } from './occTypes'

const oc = await loadOcc()
// Narrowed handle for the helpers; the describe below is skipped when oc is null,
// so these only run with a real module.
const occ = oc as OccModule

// Path-sketch plane mapped to the world XZ plane: sketchToWorld2d([u,v]) = [u,0,v].
// Right-handed (normal = x_axis x y_axis = [0,-1,0]).
const planeXZ: PlaneLike = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 0, 1], normal: [0, -1, 0] }
// Profile plane = world XY; its +Z normal is the spine tangent at the arc start.
const planeXY: PlaneLike = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }
const squareLoops: LoopEdge[][] = [[
  { kind: 'line', start: [-2, -2], end: [2, -2] },
  { kind: 'line', start: [2, -2], end: [2, 2] },
  { kind: 'line', start: [2, 2], end: [-2, 2] },
  { kind: 'line', start: [-2, 2], end: [-2, -2] },
]]

const R = 10
const CX = 10
const CY = 0

function massProps(occ: OccModule, scope: DisposeScope, solid: OccShape): { vol: number; c: number[] } {
  const props = scope.track(new occ.GProp_GProps_1())
  occ.BRepGProp.VolumeProperties_1(solid, props, true, false, false)
  const com = scope.track(props.CentreOfMass())
  return { vol: Math.abs(props.Mass()), c: [com.X(), com.Y(), com.Z()] }
}

// Analytic centroid of the arc (= solid centroid) in world coords.
function expectedCentroid(a0: number, a1: number, ccw: boolean): number[] {
  const span = ccw ? ((a1 - a0 + 360) % 360) : -(((a0 - a1 + 360) % 360))
  const half = Math.abs(span) / 2
  const midDeg = a0 + span / 2
  const d = (R * Math.sin((half * Math.PI) / 180)) / ((half * Math.PI) / 180)
  const u = CX + d * Math.cos((midDeg * Math.PI) / 180)
  const v = CY + d * Math.sin((midDeg * Math.PI) / 180)
  return [u, 0, v]  // planeXZ: [u,v] -> [u,0,v]
}

// Sweep a single arc (angles a0->a1, ccw) and return mass props.
function arcSweep(a0: number, a1: number, ccw: boolean): { vol: number; c: number[] } {
  const scope = new DisposeScope()
  try {
    const sk = 'sk'
    const repo = new Repository()
    repo.register('_pt_' + sk, planeXZ)
    const pt = (deg: number): number[] => [CX + R * Math.cos(deg * Math.PI / 180), CY + R * Math.sin(deg * Math.PI / 180)]
    repo.register('_topo_' + sk, {
      edges: [{
        entity_id: 'A1', edge_index: 0, kind: 'arc', center: [CX, CY], radius: R,
        start: pt(a0), end: pt(a1), angle_start_deg: a0, angle_end_deg: a1, ccw,
      }],
    })
    const [spine] = collectPathEdges(occ, scope, sk, repo)
    const { solid } = sweepProfileWithLineage(occ, scope, squareLoops, planeXY, spine, sk)
    return massProps(occ, scope, solid)
  } finally {
    scope.dispose()
  }
}

function dist(a: number[], b: number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

describe.skipIf(!oc)('sweep spine shape + stability (real OCC)', () => {
  it('arc spine centroid lands on the correct side of the circle (not just right volume)', () => {
    // ccw=false 90deg arc 180->90: sweeps the +z minor arc through 135deg.
    const r = arcSweep(180, 90, false)
    const exp = expectedCentroid(180, 90, false)
    expect(r.c[2]).toBeGreaterThan(0)               // on the +z side
    expect(dist(r.c, exp)).toBeLessThan(0.4)        // matches analytic arc centroid
  })

  it('flipping ccw mirrors the arc to the other side (volume-invariant, shape-sensitive)', () => {
    // Same endpoints region but the opposite 90deg minor arc 180->270 (ccw=true)
    // sweeps through 225deg -> -z side. Volume identical, centroid mirrored.
    const plus = arcSweep(180, 90, false)
    const minus = arcSweep(180, 270, true)
    expect(plus.vol).toBeCloseTo(minus.vol, 1)      // same length -> same volume
    expect(plus.c[2]).toBeGreaterThan(0)
    expect(minus.c[2]).toBeLessThan(0)              // genuinely the other side
  })

  it('centroid is continuous under a tiny sketch perturbation (no flips)', () => {
    const base = arcSweep(180, 90, false)
    const nudged = arcSweep(180, 90 - 0.02, false)
    expect(dist(base.c, nudged.c)).toBeLessThan(0.05)
  })

  it('line -> arc spine builds a connected solid with the arc swept the right way', () => {
    // L1 runs origin -> arc start with +z-ish entry; the arc then continues. This
    // is the multi-segment case where an arc oriented for a face (not the chain)
    // sweeps backward and collapses the solid to a flat face.
    const scope = new DisposeScope()
    try {
      const sk = 'sk'
      const repo = new Repository()
      repo.register('_pt_' + sk, planeXZ)
      const pt = (deg: number): number[] => [CX + R * Math.cos(deg * Math.PI / 180), CY + R * Math.sin(deg * Math.PI / 180)]
      const aStart = pt(180)  // [0,0]
      const aEnd = pt(90)     // [10,10]
      repo.register('_topo_' + sk, {
        edges: [
          { entity_id: 'L1', edge_index: 0, kind: 'line', start: [aStart[0], aStart[1] - 6], end: aStart },
          { entity_id: 'A1', edge_index: 1, kind: 'arc', center: [CX, CY], radius: R, start: aStart, end: aEnd, angle_start_deg: 180, angle_end_deg: 90, ccw: false },
        ],
      })
      const [spine] = collectPathEdges(occ, scope, sk, repo)
      expect(spine.length).toBe(2)
      const { solid } = sweepProfileWithLineage(occ, scope, squareLoops, planeXY, spine, sk)
      const { vol, c } = massProps(occ, scope, solid)
      // Line (length 6, vol 96) + arc (quarter, vol ~251) -> well above the
      // single-face / single-segment degenerate volumes.
      expect(vol).toBeGreaterThan(300)
      expect(c[2]).toBeGreaterThan(0)  // arc bent toward +z, so centroid is +z
    } finally {
      scope.dispose()
    }
  })

  it('an arc the chain walks BACKWARD sweeps the same shape as forward', () => {
    // Same line -> arc, but the arc's stored start/end are swapped so the chain
    // must reverse it (reversed=true) to connect L1. The spine arc must still
    // sweep the identical geometry -- this is the "second segment broken /
    // direction wrong" case.
    const sweepIt = (arcStartDeg: number, arcEndDeg: number): { vol: number; c: number[] } => {
      const scope = new DisposeScope()
      try {
        const sk = 'sk'
        const repo = new Repository()
        repo.register('_pt_' + sk, planeXZ)
        const pt = (deg: number): number[] => [CX + R * Math.cos(deg * Math.PI / 180), CY + R * Math.sin(deg * Math.PI / 180)]
        const aStart = pt(180)
        repo.register('_topo_' + sk, {
          edges: [
            { entity_id: 'L1', edge_index: 0, kind: 'line', start: [aStart[0], aStart[1] - 6], end: aStart },
            { entity_id: 'A1', edge_index: 1, kind: 'arc', center: [CX, CY], radius: R, start: pt(arcStartDeg), end: pt(arcEndDeg), angle_start_deg: arcStartDeg, angle_end_deg: arcEndDeg, ccw: arcStartDeg < arcEndDeg },
          ],
        })
        const [spine] = collectPathEdges(occ, scope, sk, repo)
        const { solid } = sweepProfileWithLineage(occ, scope, squareLoops, planeXY, spine, sk)
        return massProps(occ, scope, solid)
      } finally {
        scope.dispose()
      }
    }
    // Forward: arc stored 180->90 (cw), starts at the line's far end -> reversed=false.
    const fwd = sweepIt(180, 90)
    // Backward: arc stored 90->180 (ccw), its END is the line junction -> reversed=true.
    const bwd = sweepIt(90, 180)
    expect(bwd.vol).toBeCloseTo(fwd.vol, 1)
    expect(dist(bwd.c, fwd.c)).toBeLessThan(0.05)
  })
})
