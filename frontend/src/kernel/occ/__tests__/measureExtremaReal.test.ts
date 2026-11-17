// @vitest-environment node
//
// The OCCT half of a measurement readout, against the real kernel: the minimum
// distance between two shapes and the length of a curve with no closed form.
// The readers are thin, so the tests are the independent check: a box against a
// sphere where the gap is arithmetic, two skew edges where the core's closed
// form is the answer, and the two edge kinds the analytic table cannot answer
// (a spline, a partial ellipse) against a numeric integration.
//
// Skips when OCC.js or the Rust sketch solver is absent.
import { describe, expect, it } from 'vitest'
import { loadOcc } from '../loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { resetSketchSolver, setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import { persistentTableForTest, setSolveLocalsForTest, solveLocally } from '@/kernel/solveLocally'
import { DisposeScope } from '../disposeScope'
import { makeBox, makeBoxAt, readSolidEdges } from '../primitives'
import { booleanWithDiff } from '../booleans'
import { makeHalfSpaceBox } from '../halfSpace'
import { canonicalEdges } from '../bodyNames'
import { edgeLength, minDistance } from '../measureExtrema'
import { segmentDistance, type Vec3 } from '@/utils/measure/primitives'
import type { Body, BuildState } from '@/kernel/types3d'
import type { OccCurveAdaptor, OccModule, OccShape } from '../occTypes'

const loaded = await loadOcc()
const solveBytes = loadSolver()
const oc = loaded

/** A gp_Pnt, scope-tracked. */
function pnt(occ: OccModule, scope: DisposeScope, p: readonly number[]) {
  return scope.track(new occ.gp_Pnt_3(p[0], p[1], p[2]))
}

/** A straight edge between two points. */
function edge(occ: OccModule, scope: DisposeScope, a: readonly number[], b: readonly number[]): OccShape {
  return scope.track(new occ.BRepBuilderAPI_MakeEdge_3(pnt(occ, scope, a), pnt(occ, scope, b))).Edge()
}

/** A clamped uniform cubic edge through four control points. */
function cubicSpline(occ: OccModule, scope: DisposeScope, points: readonly number[][]): OccShape {
  const poles = scope.track(new occ.TColgp_Array1OfPnt_2(1, points.length))
  points.forEach((p, i) => poles.SetValue(i + 1, pnt(occ, scope, p)))
  const knots = scope.track(new occ.TColStd_Array1OfReal_2(1, 2))
  knots.SetValue(1, 0)
  knots.SetValue(2, 1)
  const mults = scope.track(new occ.TColStd_Array1OfInteger_2(1, 2))
  mults.SetValue(1, 4)
  mults.SetValue(2, 4)
  // The handle ADOPTS the raw curve (occ/__tests__/handleAdoptsRaw.test.ts), so
  // the curve itself is never scope-tracked: tracking both would delete it
  // twice. The handle owns it and the scope owns the handle.
  const curve = new occ.Geom_BSplineCurve_1(poles, knots, mults, 3, false)
  const handle = scope.track(new occ.Handle_Geom_Curve_2(curve))
  return scope.track(new occ.BRepBuilderAPI_MakeEdge_24(handle)).Edge()
}

function sphere(occ: OccModule, scope: DisposeScope, center: readonly number[], radius: number): OccShape {
  return scope.track(new occ.BRepPrimAPI_MakeSphere_5(pnt(occ, scope, center), radius)).Shape()
}

/** The +x face of an axis-aligned box built at the given corner. */
function faceAtX(occ: OccModule, scope: DisposeScope, solid: OccShape, x: number): OccShape {
  const E = occ.TopAbs_ShapeEnum
  const exp = scope.track(new occ.TopExp_Explorer_2(solid, E.TopAbs_FACE, E.TopAbs_SHAPE))
  for (; exp.More(); exp.Next()) {
    const face = scope.track(occ.TopoDS.Face_1(exp.Current()))
    const box = scope.track(new occ.Bnd_Box_1())
    occ.BRepBndLib.AddOptimal(face, box, false, false)
    if (Math.abs(box.GetXMax() - x) < 1e-9 && Math.abs(box.GetXMin() - x) < 1e-9) return face
  }
  throw new Error(`no face at x=${x}`)
}

/** The curve adaptor of an edge, scope-tracked. */
function adaptor(occ: OccModule, scope: DisposeScope, shape: OccShape): OccCurveAdaptor {
  return scope.track(new occ.BRepAdaptor_Curve_2(shape))
}

/** A dense polyline length: the independent value for a curve with no closed
 *  form. Both endpoints included, so the sum converges from below as O(1/N^2). */
function polylineLength(occ: OccModule, scope: DisposeScope, shape: OccShape, steps = 20_000): number {
  const curve = adaptor(occ, scope, shape)
  const u0 = curve.FirstParameter()
  const u1 = curve.LastParameter()
  let total = 0
  const first = curve.Value(u0)
  let last: [number, number, number] = [first.X(), first.Y(), first.Z()]
  for (let i = 1; i <= steps; i++) {
    const p = curve.Value(u0 + ((u1 - u0) * i) / steps)
    const next: [number, number, number] = [p.X(), p.Y(), p.Z()]
    total += Math.hypot(next[0] - last[0], next[1] - last[1], next[2] - last[2])
    last = next
  }
  return total
}

/** Simpson's rule over an ellipse arc's speed, the closed-form answer for the
 *  partial-ellipse edge length. */
function ellipseArcLength(a: number, b: number, u0: number, u1: number, steps = 4_000): number {
  const speed = (t: number): number => Math.hypot(a * Math.sin(t), b * Math.cos(t))
  const h = (u1 - u0) / steps
  let total = speed(u0) + speed(u1)
  for (let i = 1; i < steps; i++) total += (i % 2 === 1 ? 4 : 2) * speed(u0 + h * i)
  return (h / 3) * total
}

function findEdge(occ: OccModule, scope: DisposeScope, solid: OccShape, kind: string, partial = false): OccShape {
  const S = occ.GeomAbs_CurveType
  for (const candidate of canonicalEdges(occ, scope, solid)) {
    const curve = adaptor(occ, scope, candidate as unknown as OccShape)
    const at = curve.GetType().value
    const span = Math.abs(curve.LastParameter() - curve.FirstParameter())
    if (kind === 'spline' && at === S.GeomAbs_BSplineCurve.value) return candidate as unknown as OccShape
    if (kind === 'ellipse' && at === S.GeomAbs_Ellipse.value && (partial ? span < Math.PI * 2 : true)) {
      return candidate as unknown as OccShape
    }
  }
  throw new Error(`no ${kind} edge on the solid`)
}

/** A cylinder cut obliquely through the top: the rim is a partial elliptical
 *  edge, the shape `bodyPrimitive` classifies as opaque. */
function obliqueCylinder(occ: OccModule, scope: DisposeScope): OccShape {
  const cylinder = scope.track(new occ.BRepPrimAPI_MakeCylinder_3(
    scope.track(new occ.gp_Ax2_4(
      pnt(occ, scope, [0, 0, 0]),
      scope.track(new occ.gp_Dir_5(0, 0, 1)),
    )),
    10,
    20,
  )).Shape()
  // The plane runs through the axis at 45 degrees, so it leaves the top cap on
  // one side and the side wall on the other: the cut face's rim is an ellipse
  // arc plus the chord where it meets the cap.
  const normal: Vec3 = [0, Math.SQRT1_2, Math.SQRT1_2]
  const origin: Vec3 = [0, 0, 14]
  const { shape: tool } = makeHalfSpaceBox(occ, scope, origin, normal, cylinder)
  return booleanWithDiff(occ, scope, cylinder, tool, 'cut').shape
}

describe.skipIf(!oc)('measureExtrema (real OCC)', () => {
  it('reads a box-to-sphere gap and puts the witness points on each shape', () => {
    const occ = oc as OccModule
    const scope = new DisposeScope()
    try {
      const box = makeBoxAt(occ, scope, [-5, -5, -5], 10, 10, 10)
      const ball = sphere(occ, scope, [20, 0, 0], 5)
      const gap = minDistance(occ, box, ball)
      expect(gap).not.toBeNull()
      // 20 - 5 (half the box) - 5 (the sphere) = 10, exactly.
      expect(gap!.value).toBeCloseTo(10, 9)
      expect(gap!.p1[0]).toBeCloseTo(5, 9)
      // The lateral coordinates sit within the extrema solver's own tolerance
      // of 0, not exactly on it.
      expect(gap!.p1[1]).toBeCloseTo(0, 6)
      expect(gap!.p2[0]).toBeCloseTo(15, 9)
      expect(gap!.p2[1]).toBeCloseTo(0, 6)
      // Each witness point lies on its own shape.
      expect(Math.hypot(gap!.p2[0] - 20, gap!.p2[1], gap!.p2[2])).toBeCloseTo(5, 9)
      expect(Math.abs(gap!.p1[0])).toBeCloseTo(5, 9)

      // The same gap read face-to-face: the box's +x face against the sphere.
      const face = faceAtX(occ, scope, box, 5)
      const faceGap = minDistance(occ, face, ball)
      expect(faceGap).not.toBeNull()
      expect(faceGap!.value).toBeCloseTo(10, 9)
    } finally {
      scope.dispose()
    }
  })

  it('reads two skew straight edges as the core closed form does', () => {
    const occ = oc as OccModule
    const scope = new DisposeScope()
    try {
      // A runs along x at y=0, z=0; B passes over it at z=4, from y=3 to y=7.
      const a = edge(occ, scope, [0, 0, 0], [10, 0, 0])
      const b = edge(occ, scope, [5, 3, 4], [5, 7, 4])
      const read = minDistance(occ, a, b)
      expect(read).not.toBeNull()
      const closedForm = segmentDistance([0, 0, 0], [10, 0, 0], [5, 3, 4], [5, 7, 4])
      expect(read!.value).toBeCloseTo(closedForm, 9)
      // The witness on A is the foot of the gap, and on B the segment's start.
      expect(read!.p1[0]).toBeCloseTo(5, 9)
      expect(read!.p2[1]).toBeCloseTo(3, 9)
    } finally {
      scope.dispose()
    }
  })

  it('reads a spline edge length to the dense polyline value', () => {
    const occ = oc as OccModule
    const scope = new DisposeScope()
    try {
      // A clamped uniform cubic through a smooth arc. Four poles, 4 knots at 0
      // and 4 at 1 (the multiplicities must sum to poles + degree + 1).
      const spline = cubicSpline(occ, scope, [[0, 0, 0], [2, 1, 0], [4, 1, 0], [6, 0, 0]])
      const read = edgeLength(occ, spline)
      const expected = polylineLength(occ, scope, spline)
      expect(read).toBeGreaterThan(0)
      expect(Math.abs(read - expected) / expected).toBeLessThan(1e-6)
      expect(read).toBeGreaterThan(6)  // never the straight chord (6) or shorter
    } finally {
      scope.dispose()
    }
  })

  it('pins BRepGProp fixed-rule accuracy on a near-cusp cubic', () => {
    // The one accuracy limit of LinearProperties: it integrates the speed with a
    // fixed Gauss rule, and a curve whose speed nearly cancels reads high. Here
    // the control polygon doubles back, and the read is ~1.3e-3 relative high
    // against the polyline and the analytic speed integral (which agree to
    // 1e-9). Real model splines are smooth and read to 1e-6 (the corpus case
    // below); this pins the rule so a silent accuracy change is visible.
    const occ = oc as OccModule
    const scope = new DisposeScope()
    try {
      const spline = cubicSpline(occ, scope, [[0, 0, 0], [1, 4, 0], [3, -4, 0], [7, 0, 0]])
      const read = edgeLength(occ, spline)
      const expected = polylineLength(occ, scope, spline)
      const relative = (read - expected) / expected
      expect(relative).toBeGreaterThan(0)
      expect(relative).toBeLessThan(5e-3)
    } finally {
      scope.dispose()
    }
  })

  it('integrates a partial elliptical edge to the quadrature value', () => {
    const occ = oc as OccModule
    const scope = new DisposeScope()
    try {
      const solid = obliqueCylinder(occ, scope)
      const arc = findEdge(occ, scope, solid, 'ellipse', true)
      const curve = adaptor(occ, scope, arc)
      const ell = scope.track(curve.Ellipse())
      const a = ell.MajorRadius()
      const b = ell.MinorRadius()
      const u0 = curve.FirstParameter()
      const u1 = curve.LastParameter()
      // A trimmed rim, not a closed one: the shape the analytic table refuses.
      expect(Math.abs(u1 - u0)).toBeLessThan(Math.PI * 2 - 1e-9)
      expect(a).toBeGreaterThan(b)

      const read = edgeLength(occ, arc)
      expect(Math.abs(read - ellipseArcLength(a, b, u0, u1)) / read).toBeLessThan(1e-6)
    } finally {
      scope.dispose()
    }
  })

  it('reads a spline edge of a solved body, the pick the adapter calls opaque', async () => {
    const occ = oc as OccModule
    if (!solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
    setSketchTopology(loadTopology())
    setSolveLocalsForTest(async () => occ)
    try {
      // The Ex010 profile: three lines and one interpolating spline, extruded.
      const fit = [3, 1, 2.75, 1.5, 2.5, 1.75, 2, 1.5, 1.5, 1, 1, 1.25, 0.5, 1, 0, 1]
      const response = await solveLocally({
        id: 'measure-extrema-spline',
        features: [
          {
            id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
            entities: [
              { id: 'bottom', kind: 'line' }, { id: 'right', kind: 'line' },
              { id: 'sp', kind: 'fit_spline' }, { id: 'left', kind: 'line' },
            ],
            initial: { bottom: [0, 0, 3, 0], right: [3, 0, 3, 1], sp: fit, left: [0, 1, 0, 0] },
            constraints: ['bottom', 'right', 'sp', 'left'].map((id) => ({ id: `f${id}`, kind: 'fixed', target: { entity: id } })),
          },
          { id: 'ex1', kind: 'extrude', extrude: { sketch: '$sk1', distance: 1, direction: 'normal', operation: 'new' } },
        ],
      })
      if (!response) throw new Error('no response')
      const state = response._build_state as BuildState
      const store = state.checkpoints[state.feature_order[state.feature_order.length - 1]].body_store_snapshot as Record<string, Body>
      const table = persistentTableForTest()
      if (!table) throw new Error('no table')
      const bodyId = Object.keys(store)[0]
      const shape = table.get<OccShape>(store[bodyId].shape!)
      const scope2 = new DisposeScope()
      try {
        // The spline edge the render pass reports as `kind: 'spline'`; the
        // extrusion makes one per cap.
        const rows = readSolidEdges(occ, scope2, shape).filter((row) => row.ed.kind === 'spline')
        expect(rows).toHaveLength(2)
        const splineEdge = findEdge(occ, scope2, shape, 'spline')
        const read = edgeLength(occ, splineEdge)
        const expected = polylineLength(occ, scope2, splineEdge)
        expect(Math.abs(read - expected) / expected).toBeLessThan(1e-6)
        // The render row's sampled length agrees too (the same curve, sampled).
        const sampled = (rows[0].ed as { kind: 'spline'; points: [number, number, number][] }).points
        let sum = 0
        for (let i = 1; i < sampled.length; i++) {
          sum += Math.hypot(
            sampled[i][0] - sampled[i - 1][0],
            sampled[i][1] - sampled[i - 1][1],
            sampled[i][2] - sampled[i - 1][2],
          )
        }
        expect(read).toBeGreaterThan(0)
        expect(Math.abs(read - sum) / read).toBeLessThan(0.01)
      } finally {
        scope2.dispose()
      }
    } finally {
      setSolveLocalsForTest(null)
      resetSketchSolver()
    }
  }, 300_000)
})

// The witness-point accessors are embind names, not OCCT names: a build that
// renames them fails at call time, so the reads above are the pin. This test
// states the contract in one place as well.
describe.skipIf(!oc)('BRepExtrema_DistShapeShape witness bindings (real OCC)', () => {
  it('exposes PointOnShape1/PointOnShape2 as fresh gp_Pnt proxies', () => {
    const occ = oc as OccModule
    const scope = new DisposeScope()
    try {
      const a = makeBox(occ, scope, 1, 1, 1)
      const b = makeBoxAt(occ, scope, [3, 0, 0], 1, 1, 1)
      const read = minDistance(occ, a, b)
      expect(read).not.toBeNull()
      expect(read!.value).toBeCloseTo(2, 9)
      expect(read!.p1).toHaveLength(3)
      expect(read!.p2).toHaveLength(3)
    } finally {
      scope.dispose()
    }
  })
})
