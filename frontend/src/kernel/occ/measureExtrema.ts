// The two OCCT reads a measurement cell with no analytic answer needs: the
// minimum distance between two shapes' boundaries, and the length of a curve.
//
// Both are read-only: they allocate their own proxies in a local DisposeScope
// and hand back plain numbers and points, so nothing here can leak into the
// builder's handles or disturb the cross-solve checkpoint cache.
import { swallowUnlessTrap } from '../errors'
import { OCC_CONFUSION } from '../solverConstants'
import { noProgress } from './defaultArgs'
import { DisposeScope } from './disposeScope'
import type { OccModule, OccShape } from './occTypes'
import type { Vec3 } from './primitives'

/** A minimum distance and the pair of witness points that realise it. */
export interface ExtremaDistance {
  value: number
  // On the first shape.
  p1: Vec3
  // On the second.
  p2: Vec3
}

/**
 * The minimum distance between two shapes' boundaries, or null when the read
 * does not finish. `deflection` is BRepExtrema's own sampling tolerance for the
 * curved pieces; OCC_CONFUSION is the exact read this project uses elsewhere.
 *
 * Boundary semantics: a body wholly inside another reads a POSITIVE gap, so a
 * clearance (which must read 0 for an overlap) runs the overlap probe first.
 */
export function minDistance(
  oc: OccModule,
  a: OccShape,
  b: OccShape,
  deflection: number = OCC_CONFUSION,
): ExtremaDistance | null {
  const scope = new DisposeScope()
  try {
    const probe = scope.track(new oc.BRepExtrema_DistShapeShape_3(
      a,
      b,
      deflection,
      oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN,
      oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad,
      noProgress(oc),
    ))
    if (!probe.IsDone()) return null
    // The witness points of solution 1. DistShapeShape reports the number of
    // solutions, but Value() and the point getters are all `N = 1` reads: the
    // minimum is what a readout states, and the other solutions are local
    // minima of an optimisation that found no closer pair.
    const p1 = probe.PointOnShape1(1)
    const p2 = probe.PointOnShape2(1)
    const out: ExtremaDistance = {
      value: probe.Value(),
      p1: [p1.X(), p1.Y(), p1.Z()],
      p2: [p2.X(), p2.Y(), p2.Z()],
    }
    p1.delete()
    p2.delete()
    return out
  } catch (e) {
    // A trap means the module is dead and must escape; anything else is this
    // read refusing, which the caller renders as no readout.
    swallowUnlessTrap(e)
    return null
  } finally {
    scope.dispose()
  }
}

/**
 * The length of an edge (or a wire), by BRepGProp's linear integral. A spline
 * or a partial ellipse has no closed form, which is why the readout asks the
 * kernel for these two edge kinds; a line and a full circle keep their
 * analytic answer. Returns 0 for a read that fails.
 */
export function edgeLength(oc: OccModule, edge: OccShape): number {
  const scope = new DisposeScope()
  try {
    const props = scope.track(new oc.GProp_GProps_1())
    // Not shared (an edge's own geometry counts once) and not triangulated (the
    // mesher's polyline is an approximation; this must be the exact curve).
    oc.BRepGProp.LinearProperties(edge, props, false, false)
    return props.Mass()
  } catch (e) {
    swallowUnlessTrap(e)
    return 0
  } finally {
    scope.dispose()
  }
}
