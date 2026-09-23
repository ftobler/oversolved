// @vitest-environment node
//
// Real-OCC tests for canonicalSurfaces.ts (the boolean-result cylinder
// recognizer).  A fillet along the straight seam of two fused equal-radius
// cylinders is geometrically an exact cylinder strip, but ChFi3d emits it as a
// rational BSpline surface; canonicalizeCylinderFaces must rebuild it on an
// analytic gp_Cylinder without disturbing the solid (validity, volume), and
// must leave shapes with nothing to recognize untouched.
//
// The end-to-end weld-merge this enables (an add-extrude on a filleted body
// staying one face per wall) is covered by
// features/extrudeDiscontinuityReal.test.ts.

import { describe, it, expect } from 'vitest'
import { loadOcc } from './loadOcc'
import { DisposeScope } from './disposeScope'
import { makeBox, makeCylinder } from './primitives'
import { booleanWithHistory, volumeOf } from './booleans'
import { applyFilletWithDiff } from './edgeModifier'
import { canonicalizeCylinderFaces } from './canonicalSurfaces'
import type { OccModule, OccShape, OccSubShape } from './occTypes'

const oc = await loadOcc()

/** Append `edge` unless an IsSame twin is already collected (a solid's
 *  explorer visits each edge once per adjacent face). */
function pushUnique(edges: OccShape[], edge: OccShape): void {
  if (!edges.some((e) => (e as OccSubShape).IsSame(edge as OccSubShape))) edges.push(edge)
}

/** GeomAbs type value per face, in explorer order. */
function faceTypes(oc2: OccModule, scope: DisposeScope, shape: OccShape): number[] {
  const E = oc2.TopAbs_ShapeEnum
  const exp = scope.track(new oc2.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  const out: number[] = []
  for (; exp.More(); exp.Next()) {
    const face = scope.track(oc2.TopoDS.Face_1(exp.Current()))
    out.push(scope.track(new oc2.BRepAdaptor_Surface_2(face, false)).GetType().value)
  }
  return out
}

/**
 * Two overlapping equal-radius vertical cylinders fused, then a fillet on the
 * two straight seam edges where their walls cross.  The fillet strips come
 * back as BSpline surfaces even though they are exact cylinder patches.
 */
function filletedLensUnion(oc2: OccModule, scope: DisposeScope, filletRadius: number): OccShape {
  const a = makeCylinder(oc2, scope, [0, 0, 0], [0, 0, 1], 10, 10)
  const b = makeCylinder(oc2, scope, [13, 0, 0], [0, 0, 1], 10, 10)
  const fused = booleanWithHistory(oc2, scope, a, b, 'fuse').shape
  // The seam edges are the two vertical lines at x = 6.5 (wall intersection);
  // each cylinder's own U-seam line sits at x = 10 resp. x = 23, outside the
  // filter window.
  const E = oc2.TopAbs_ShapeEnum
  const exp = scope.track(new oc2.TopExp_Explorer_2(fused, E.TopAbs_EDGE, E.TopAbs_SHAPE))
  const seamEdges: OccShape[] = []
  for (; exp.More(); exp.Next()) {
    const edge = scope.track(oc2.TopoDS.Edge_1(exp.Current()))
    const ad = scope.track(new oc2.BRepAdaptor_Curve_2(edge))
    if (ad.GetType().value !== oc2.GeomAbs_CurveType.GeomAbs_Line.value) continue
    const p = scope.track(ad.Value((ad.FirstParameter() + ad.LastParameter()) / 2))
    if (p.X() > 0.5 && p.X() < 12.5) pushUnique(seamEdges, edge)
  }
  expect(seamEdges).toHaveLength(2)
  const res = applyFilletWithDiff(oc2, scope, fused, filletRadius, seamEdges)
  expect(res.success).toBe(true)
  return res.shape
}

describe.skipIf(!oc)('canonicalizeCylinderFaces', () => {
  it('rebuilds BSpline fillet strips as analytic cylinders, preserving the solid', () => {
    const scope = new DisposeScope()
    try {
      const filleted = filletedLensUnion(oc!, scope, 1)
      const planeType = oc!.GeomAbs_SurfaceType.GeomAbs_Plane.value
      const cylType = oc!.GeomAbs_SurfaceType.GeomAbs_Cylinder.value

      // Precondition: the fillet really did emit non-analytic strips (if a
      // future OCCT emits analytic fillets here, this test loses its subject).
      const before = faceTypes(oc!, scope, filleted)
      const nonAnalytic = before.filter((t) => t !== planeType && t !== cylType)
      expect(nonAnalytic.length).toBeGreaterThan(0)

      const volume = volumeOf(oc!, scope, filleted)
      const result = canonicalizeCylinderFaces(oc!, scope, filleted)

      expect(result.changed).toBe(true)
      expect(result.swaps).toHaveLength(nonAnalytic.length)
      const after = faceTypes(oc!, scope, result.shape)
      expect(after.length).toBe(before.length)
      expect(after.every((t) => t === planeType || t === cylType)).toBe(true)
      expect(scope.track(new oc!.BRepCheck_Analyzer(result.shape, true)).IsValid_2()).toBe(true)
      expect(volumeOf(oc!, scope, result.shape)).toBeCloseTo(volume, 6)

      // The swap targets must reference sub-shapes of the RETURNED (healed)
      // shape -- a BrepDiff mapped through them is dead weight otherwise.
      const E = oc!.TopAbs_ShapeEnum
      const exp = scope.track(new oc!.TopExp_Explorer_2(result.shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
      const healedFaces: OccSubShape[] = []
      for (; exp.More(); exp.Next()) healedFaces.push(scope.track(oc!.TopoDS.Face_1(exp.Current())) as OccSubShape)
      for (const swap of result.swaps) {
        expect(healedFaces.some((f) => f.IsSame(swap.to))).toBe(true)
      }
    } finally {
      scope.dispose()
    }
  })

  it('returns the input untouched when every face is already analytic', () => {
    const scope = new DisposeScope()
    try {
      const box = makeBox(oc!, scope, 10, 10, 10)
      const result = canonicalizeCylinderFaces(oc!, scope, box)
      expect(result.changed).toBe(false)
      expect(result.swaps).toHaveLength(0)
      expect(result.shape).toBe(box)
    } finally {
      scope.dispose()
    }
  })

  it('leaves genuinely free-form faces alone (fit gate)', () => {
    const scope = new DisposeScope()
    try {
      // A fillet around a box's top face rim: the corner patches are sphere
      // pieces (non-analytic emit, but NOT cylinders about one axis), so at
      // most the straight-edge strips may canonicalize; the solid must stay
      // valid and keep its volume either way.
      const box = makeBox(oc!, scope, 10, 10, 10)
      const E = oc!.TopAbs_ShapeEnum
      const exp = scope.track(new oc!.TopExp_Explorer_2(box, E.TopAbs_EDGE, E.TopAbs_SHAPE))
      const topEdges: OccShape[] = []
      for (; exp.More(); exp.Next()) {
        const edge = scope.track(oc!.TopoDS.Edge_1(exp.Current()))
        const ad = scope.track(new oc!.BRepAdaptor_Curve_2(edge))
        const p1 = scope.track(ad.Value(ad.FirstParameter()))
        const p2 = scope.track(ad.Value(ad.LastParameter()))
        if (Math.abs(p1.Z() - 10) < 1e-9 && Math.abs(p2.Z() - 10) < 1e-9) pushUnique(topEdges, edge)
      }
      expect(topEdges).toHaveLength(4)
      const res = applyFilletWithDiff(oc!, scope, box, 2, topEdges)
      expect(res.success).toBe(true)
      const volume = volumeOf(oc!, scope, res.shape)
      const result = canonicalizeCylinderFaces(oc!, scope, res.shape)
      expect(volumeOf(oc!, scope, result.shape)).toBeCloseTo(volume, 6)
      expect(scope.track(new oc!.BRepCheck_Analyzer(result.shape, true)).IsValid_2()).toBe(true)
    } finally {
      scope.dispose()
    }
  })

  it('refuses a healed result that fails BRepCheck, returning the input unchanged', () => {
    // ShapeFix can hand back a shape that validates as broken. Recognition must
    // not adopt it: the guard returns the ORIGINAL solid (identity), because the
    // un-canonicalized boolean result is sound, it just keeps the seam.
    const scope = new DisposeScope()
    const mod = oc! as unknown as { BRepCheck_Analyzer: unknown }
    const realAnalyzer = mod.BRepCheck_Analyzer
    try {
      const filleted = filletedLensUnion(oc!, scope, 1)
      // Precondition: without the forced failure the pass does rebuild the faces.
      expect(canonicalizeCylinderFaces(oc!, scope, filleted).changed).toBe(true)
      mod.BRepCheck_Analyzer = function () {
        return { IsValid_2: () => false, delete: () => {} }
      }
      const result = canonicalizeCylinderFaces(oc!, scope, filleted)
      expect(result.changed).toBe(false)
      expect(result.swaps).toHaveLength(0)
      expect(result.shape).toBe(filleted)
    } finally {
      mod.BRepCheck_Analyzer = realAnalyzer
      scope.dispose()
    }
  })
})

describe('canonicalizeCylinderFaces best-effort refusal', () => {
  it('returns the input untouched when recognition itself throws', () => {
    // The whole pass is wrapped: any OCC failure (an enum read, an adaptor)
    // leaves the caller with the original shape rather than an exception. A
    // throwing enum read is enough to enter that path before any geometry runs.
    const scope = new DisposeScope()
    try {
      const shape = { delete: () => {} } as unknown as OccShape
      const ocFake = {
        get TopAbs_ShapeEnum(): never {
          throw new Error('kernel unavailable')
        },
      } as unknown as OccModule
      const result = canonicalizeCylinderFaces(ocFake, scope, shape)
      expect(result.changed).toBe(false)
      expect(result.swaps).toEqual([])
      expect(result.shape).toBe(shape)
    } finally {
      scope.dispose()
    }
  })
})
