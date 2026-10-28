// @vitest-environment node
//
// Real-OCC guard for the fit-spline chain edge: the Ex010 profile (three lines
// plus one interpolating spline) extrudes to CadQuery's measured volume, and
// the spline edge is one C2 B-spline, not a chord. Skips when opencascade.js is
// absent.
import { describe, it, expect } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import { volumeOf } from '../booleans'
import { extrudeProfileWithLineage } from '../prismLineage'
import type { PlaneLike } from '../../features/shared/planes'
import type { LoopEdge } from '../../profileLoops'
import type { OccModule, OccShape, OccSubShape } from '../occTypes'
import { interpolateFitSpline } from '@/utils/geometry/fitSpline'

const oc = await loadOcc()

const XY: PlaneLike = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }

/** Every B-spline edge of a solid, with the pole count and continuity OCC reads
 *  back from the curve the writer handed it. */
function splineEdges(
  oc2: OccModule,
  scope: DisposeScope,
  shape: OccShape,
): Array<{ poles: number; continuity: number }> {
  const E = oc2.TopAbs_ShapeEnum
  const exp = scope.track(new oc2.TopExp_Explorer_2(shape, E.TopAbs_EDGE, E.TopAbs_SHAPE))
  const out: Array<{ poles: number; continuity: number }> = []
  const seen: OccShape[] = []
  for (; exp.More(); exp.Next()) {
    const edge = scope.track(oc2.TopoDS.Edge_1(exp.Current()))
    // The explorer visits a shared edge once per adjacent face; count it once.
    if (seen.some((s) => (s as OccSubShape).IsSame(edge as OccSubShape))) continue
    seen.push(edge)
    const adaptor = scope.track(new oc2.BRepAdaptor_Curve_2(edge))
    if (adaptor.GetType().value !== oc2.GeomAbs_CurveType.GeomAbs_BSplineCurve.value) continue
    const curve = scope.track(adaptor.BSpline()).get()
    out.push({ poles: curve.NbPoles(), continuity: curve.Continuity().value })
  }
  return out
}

const EX010: [number, number][] = [
  [3, 1],
  [2.75, 1.5],
  [2.5, 1.75],
  [2, 1.5],
  [1.5, 1],
  [1, 1.25],
  [0.5, 1],
  [0, 1],
]

describe.skipIf(!oc)('fit spline chain edge (real OCC)', () => {
  it('extrudes the Ex010 profile to CadQuery volume', () => {
    const scope = new DisposeScope()
    const curve = interpolateFitSpline(EX010)
    const loop: LoopEdge[] = [
      { kind: 'line', start: [0, 0], end: [3, 0] },
      { kind: 'line', start: [3, 0], end: [3, 1] },
      { kind: 'fit_spline', start: [3, 1], end: [0, 1], poles: curve.poles(), knots: [...curve.knots] },
      { kind: 'line', start: [0, 1], end: [0, 0] },
    ]
    const { solid } = extrudeProfileWithLineage(oc!, scope, [loop], XY, [0, 0, 1], 0.5, 'sk')
    const vol = volumeOf(oc!, scope, solid)
    // CadQuery 2.8.0: 1.8925830470835936. OCC's own volume integration on the
    // same B-spline is deterministic, so a chord (which would be a different
    // area) fails well outside this window.
    expect(vol).toBeCloseTo(1.8925830470835936, 6)

    // The plan's spec, not just the volume: the writer's knot removal must
    // leave OCC's clamped C2 curve (Ex010's 8 fit points -> 10 poles), or the
    // profile is the C0 chain with a different B-rep behind the same area.
    const curves = splineEdges(oc!, scope, solid)
    expect(curves).toHaveLength(2)  // the bottom and top copies
    for (const curve of curves) {
      expect(curve.poles).toBe(10)
      expect(curve.continuity).toBeGreaterThanOrEqual(oc!.GeomAbs_Shape.GeomAbs_C2.value)
    }
    scope.dispose()
  })

  it('a fit-spline profile is not the chord approximation', () => {
    const scope = new DisposeScope()
    const curve = interpolateFitSpline(EX010)
    const loop: LoopEdge[] = [
      { kind: 'line', start: [0, 0], end: [3, 0] },
      { kind: 'line', start: [3, 0], end: [3, 1] },
      { kind: 'fit_spline', start: [3, 1], end: [0, 1], poles: curve.poles(), knots: [...curve.knots] },
      { kind: 'line', start: [0, 1], end: [0, 0] },
    ]
    const { solid } = extrudeProfileWithLineage(oc!, scope, [loop], XY, [0, 0, 1], 0.5, 'sk')
    const vol = volumeOf(oc!, scope, solid)
    // The straight chord from (3,1) to (0,1) gives exactly 1.5; the bulged
    // curve is far above it.
    expect(Math.abs(vol - 1.5)).toBeGreaterThan(0.3)
    scope.dispose()
  })
})
