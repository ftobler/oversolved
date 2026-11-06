// @vitest-environment node
//
// A raw Geom curve or surface wrapped in a `Handle_*` belongs to the Handle:
// the edge built from it keeps it alive through the OCC refcount. Tracking the
// raw object in the DisposeScope as well made `dispose()` run `delete` on it
// regardless of that refcount, so every Bezier, B-spline chain, full ellipse
// and helix edge outlived the scope pointing at freed memory. A full build
// never noticed; the cached edge in a checkpoint corrupted the heap on the next
// incremental solve (fuzz-session seed 33: "memory access out of bounds" in a
// later dispose). Each producer's edge must still evaluate after the scope
// that built it is gone, and match what it evaluated to before. With the raw
// curve tracked, the second sample traps ("table index is out of bounds").
import { describe, it, expect } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import { makeBezierEdge, makeBSplineChainEdge, makeEllipseEdge, type Vec3 } from '../primitives'
import type { OccModule, OccShape } from '../occTypes'

const oc = await loadOcc()

function sample(occ: OccModule, edge: OccShape): number[] {
  const scope = new DisposeScope()
  try {
    const ad = scope.track(new occ.BRepAdaptor_Curve_2(edge))
    const out: number[] = []
    const u0 = ad.FirstParameter()
    const u1 = ad.LastParameter()
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const p = scope.track(ad.Value(u0 + (u1 - u0) * t))
      out.push(p.X(), p.Y(), p.Z())
    }
    return out
  } finally {
    scope.dispose()
  }
}

// Build in a scope, sample, dispose the scope, churn the allocator so freed
// blocks are reused, then sample again: a curve the scope freed reads garbage
// or traps instead of repeating the first sample.
function survivesScope(occ: OccModule, build: (scope: DisposeScope) => OccShape): void {
  const scope = new DisposeScope()
  const edge = build(scope)
  const before = sample(occ, edge)
  scope.dispose()
  const churn = new DisposeScope()
  for (let i = 0; i < 200; i++) churn.track(new occ.gp_Pnt_3(i, i, i))
  churn.dispose()
  try {
    const after = sample(occ, edge)
    after.forEach((v, i) => expect(v).toBeCloseTo(before[i], 9))
  } finally {
    edge.delete()
  }
}

const poles: Vec3[] = [[0, 0, 0], [1, 2, 0], [3, 2, 0], [4, 0, 0]]

describe.skipIf(!oc)('curve producers hand their raw Geom object to the Handle', () => {
  it('a Bezier edge outlives its scope', () => {
    survivesScope(oc as OccModule, s => makeBezierEdge(oc as OccModule, s, poles))
  })

  it('a B-spline chain edge outlives its scope', () => {
    const chain: Vec3[] = [...poles, [5, -2, 0], [7, -2, 0], [8, 0, 0]]
    survivesScope(oc as OccModule, s => makeBSplineChainEdge(oc as OccModule, s, chain, [0, 0.5, 1]))
  })

  it('a full ellipse edge outlives its scope', () => {
    survivesScope(oc as OccModule, s => makeEllipseEdge(oc as OccModule, s, [0, 0, 0], [0, 0, 1], [1, 0, 0], 5, 3))
  })
  // No helix case: buildCurveEdge runs BRepLib.BuildCurves3d, so the edge's
  // 3D curve is a fresh B-spline and sampling it never touches the adopted
  // surface or 2D line. handleAdoptsRaw.test.ts covers helixEdge.ts instead.
})
