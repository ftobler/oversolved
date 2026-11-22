// @vitest-environment node
//
// Real-OCC tests for the residual-seam re-seat (`cleanup/reseatSeams.ts`).
//
// The reported defect: a revolve's seam is the profile itself, so a slot cut
// through it leaves the seam ending on the slot rim at z=0. The rim then needs
// a vertex there, splits in two, and a fillet/chamfer picked on one half blends
// the whole tangent chain as two faces. The pass moves the seam into the
// largest free u gap of the face's own boundary, and the following
// UnifySameDomain folds the rim halves.
//
// The spike measurements behind the mechanism (full-period rebuild, not
// FixMissingSeam) are recorded in feature/bug-seam-residual-split.md.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import {
  makeArcEdge,
  makeBoxAt,
  makeCylinder,
  makeFaceFromWire,
  makeLineEdge,
  makeWire,
  readSolidEdges,
} from '../primitives'
import { revolveFace } from '../prismLineage'
import { booleanWithDiffMany, cleanWithHistory } from '../booleans'
import { runCleanup } from '../cleanup/pipeline'
import { reseatSeams } from '../cleanup/reseatSeams'
import type { CleanupPass } from '../cleanup/types'
import { volumeOfDefault } from '../volume'
import type { OccModule, OccShape, OccSubShape, OccOrientableShape } from '../occTypes'

const oc = await loadOcc()

function faces(oc2: OccModule, scope: DisposeScope, shape: OccShape): OccSubShape[] {
  const E = oc2.TopAbs_ShapeEnum
  const exp = scope.track(new oc2.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  const out: OccSubShape[] = []
  for (; exp.More(); exp.Next()) {
    out.push(scope.track(oc2.TopoDS.Face_1(exp.Current())) as OccSubShape)
  }
  return out
}

function faceEdges(oc2: OccModule, scope: DisposeScope, face: OccShape): OccSubShape[] {
  const E = oc2.TopAbs_ShapeEnum
  const exp = scope.track(new oc2.TopExp_Explorer_2(face, E.TopAbs_EDGE, E.TopAbs_SHAPE))
  const out: OccSubShape[] = []
  for (; exp.More(); exp.Next()) {
    const edge = scope.track(oc2.TopoDS.Edge_1(exp.Current())) as OccSubShape
    if (!out.some((e) => e.IsSame(edge))) out.push(edge)
  }
  return out
}

function verticesOf(oc2: OccModule, scope: DisposeScope, shape: OccShape): OccSubShape[] {
  const E = oc2.TopAbs_ShapeEnum
  const exp = scope.track(new oc2.TopExp_Explorer_2(shape, E.TopAbs_VERTEX, E.TopAbs_SHAPE))
  const out: OccSubShape[] = []
  for (; exp.More(); exp.Next()) {
    const v = scope.track(oc2.TopoDS.Vertex_1(exp.Current())) as OccSubShape
    if (!out.some((x) => x.IsSame(v))) out.push(v)
  }
  return out
}

function seamEdges(oc2: OccModule, scope: DisposeScope, face: OccShape): OccShape[] {
  return faceEdges(oc2, scope, face).filter((e) => oc2.BRep_Tool.IsClosed_2(e, face))
}

/** The face boundary with the seam and the degenerate pole edges dropped. */
function openBoundary(oc2: OccModule, scope: DisposeScope, face: OccShape): OccShape[] {
  return faceEdges(oc2, scope, face).filter(
    (e) => !oc2.BRep_Tool.IsClosed_2(e, face) && !oc2.BRep_Tool.Degenerated(e),
  )
}

function surfaceType(oc2: OccModule, scope: DisposeScope, face: OccShape): number {
  return scope.track(new oc2.BRepAdaptor_Surface_2(face, true)).GetType().value
}

function isValid(oc2: OccModule, scope: DisposeScope, shape: OccShape): boolean {
  return scope.track(new oc2.BRepCheck_Analyzer(shape, true, false, false)).IsValid_2()
}

function closeVolume(before: number, after: number): void {
  expect(Math.abs(after - before)).toBeLessThanOrEqual(Math.max(1e-9, 1e-6 * Math.abs(before)))
}

/** The report's part: a sphere R25 revolved about X, a 20 x 20 through-slot. */
function sphereMinusSlot(oc2: OccModule, scope: DisposeScope): OccShape {
  const arc = scope.track(makeArcEdge(oc2, scope, [0, 0, 0], [0, 0, 1], [1, 0, 0], 25, 0, Math.PI))
  const line = scope.track(makeLineEdge(oc2, scope, [-25, 0, 0], [25, 0, 0]))
  const wire = scope.track(makeWire(oc2, scope, [arc, line], { requireClosed: true }))
  const profile = scope.track(makeFaceFromWire(oc2, scope, wire))
  const sphere = scope.track(revolveFace(oc2, scope, profile, [0, 0, 0], [1, 0, 0], 360))
  const slot = scope.track(makeBoxAt(oc2, scope, [-10, 10, -30], 20, 20, 60))
  return scope.track(booleanWithDiffMany(oc2, scope, sphere, [slot], 'cut').shape)
}

function plainSphere(oc2: OccModule, scope: DisposeScope): OccShape {
  const arc = scope.track(makeArcEdge(oc2, scope, [0, 0, 0], [0, 0, 1], [1, 0, 0], 25, 0, Math.PI))
  const line = scope.track(makeLineEdge(oc2, scope, [-25, 0, 0], [25, 0, 0]))
  const wire = scope.track(makeWire(oc2, scope, [arc, line], { requireClosed: true }))
  const profile = scope.track(makeFaceFromWire(oc2, scope, wire))
  return scope.track(revolveFace(oc2, scope, profile, [0, 0, 0], [1, 0, 0], 360))
}

function plainCylinder(oc2: OccModule, scope: DisposeScope): OccShape {
  return scope.track(makeCylinder(oc2, scope, [0, 0, 0], [0, 0, 1], 10, 20))
}

/** Torus R15 r5 about Z; its u=0 seam is the tube circle at +X. */
function plainTorus(oc2: OccModule, scope: DisposeScope): OccShape {
  const ax2 = scope.track(
    new oc2.gp_Ax2_4(
      scope.track(new oc2.gp_Pnt_3(0, 0, 0)),
      scope.track(new oc2.gp_Dir_5(0, 0, 1)),
    ),
  )
  const builder = scope.track(new oc2.BRepPrimAPI_MakeTorus_5(ax2, 15, 5))
  return scope.track(builder.Shape())
}

/** The plain torus with a notch cut through its u seam on the tube's top. */
function torusCutAcrossSeam(oc2: OccModule, scope: DisposeScope): OccShape {
  const torus = plainTorus(oc2, scope)
  // Around (15, 0, 5): u=0 (+X) at v=pi/2, away from the v seam at v=0 so only
  // the u seam is cut.
  const notch = scope.track(makeBoxAt(oc2, scope, [13, -2, 3], 4, 4, 5))
  return scope.track(booleanWithDiffMany(oc2, scope, torus, [notch], 'cut').shape)
}

/**
 * A groove that wraps all but a 10 degree rib around the sphere, so its
 * boundary leaves no free u gap wide enough for a seam. The tool is the slab
 * |x| <= 12.5 minus a thin strip kept at -Y.
 */
function sphereWithNoFreeGap(oc2: OccModule, scope: DisposeScope): OccShape {
  const sphere = plainSphere(oc2, scope)
  const slab = scope.track(makeBoxAt(oc2, scope, [-12.5, -30, -30], 25, 60, 60))
  const rib = scope.track(makeBoxAt(oc2, scope, [-12.5, -30, -2], 25, 30, 4))
  const tool = scope.track(booleanWithDiffMany(oc2, scope, slab, [rib], 'cut').shape)
  return scope.track(booleanWithDiffMany(oc2, scope, sphere, [tool], 'cut').shape)
}

/** A Z cylinder band r10 h20 with an X bore r3 through its seam at z=10. */
function cylinderBandWithHole(oc2: OccModule, scope: DisposeScope): OccShape {
  const band = scope.track(makeCylinder(oc2, scope, [0, 0, 0], [0, 0, 1], 10, 20))
  const bore = scope.track(makeCylinder(oc2, scope, [-30, 0, 10], [1, 0, 0], 3, 60))
  return scope.track(booleanWithDiffMany(oc2, scope, band, [bore], 'cut').shape)
}

/** The shape's periodic face of the given type, or undefined. */
function faceOfType(
  oc2: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  kind: 'sphere' | 'cylinder' | 'torus',
): OccShape | undefined {
  const T = oc2.GeomAbs_SurfaceType
  const wanted =
    kind === 'sphere'
      ? T.GeomAbs_Sphere.value
      : kind === 'torus'
        ? T.GeomAbs_Torus.value
        : T.GeomAbs_Cylinder.value
  return faces(oc2, scope, shape).find(
    (f) => surfaceType(oc2, scope, f) === wanted,
  )
}

describe.skipIf(!oc)('reseatSeams', () => {
  it('moves the sphere-minus-slot seam and the clean folds the rim halves', () => {
    const scope = new DisposeScope()
    try {
      const shape = sphereMinusSlot(oc!, scope)
      const sphere = faceOfType(oc!, scope, shape, 'sphere')!
      const before = volumeOfDefault(oc!, scope, shape)
      // Precondition: the report's defect. Two seam pieces ending on the x=10
      // and x=-10 rim vertices, each rim side split in two there.
      expect(seamEdges(oc!, scope, sphere)).toHaveLength(2)
      expect(openBoundary(oc!, scope, sphere)).toHaveLength(6)
      expect(isValid(oc!, scope, shape)).toBe(true)

      const seated = reseatSeams(oc!, scope, shape, {})
      expect(seated.changed).toBe(true)
      const rebuilt = scope.track(seated.shape)
      closeVolume(before, volumeOfDefault(oc!, scope, rebuilt))
      expect(isValid(oc!, scope, rebuilt)).toBe(true)
      const rebuiltSphere = faceOfType(oc!, scope, rebuilt, 'sphere')!
      // Re-seat alone: the rim halves are still two edges; the merge has not
      // run. The seam is one edge at the new u=0 and touches no boundary.
      expect(seamEdges(oc!, scope, rebuiltSphere)).toHaveLength(1)
      expect(openBoundary(oc!, scope, rebuiltSphere)).toHaveLength(6)
      for (const seam of seamEdges(oc!, scope, rebuiltSphere)) {
        for (const vertex of verticesOf(oc!, scope, seam)) {
          const incident = openBoundary(oc!, scope, rebuiltSphere).filter((edge) =>
            verticesOf(oc!, scope, edge).some((v) => v.IsSame(vertex)),
          )
          expect(incident.length).toBeLessThan(2)
        }
      }

      const cleaned = scope.track(cleanWithHistory(oc!, scope, rebuilt).shape)
      closeVolume(before, volumeOfDefault(oc!, scope, cleaned))
      expect(isValid(oc!, scope, cleaned)).toBe(true)
      const cleanSphere = faceOfType(oc!, scope, cleaned, 'sphere')!
      expect(seamEdges(oc!, scope, cleanSphere)).toHaveLength(1)
      // Each x=+/-10 wall rim is one edge now, and the two y=10 arcs remain.
      expect(openBoundary(oc!, scope, cleanSphere)).toHaveLength(4)
      expect(readSolidEdges(oc!, scope, cleaned)).toHaveLength(7)
    } finally {
      scope.dispose()
    }
  }, 60_000)

  it('is a no-op on a full sphere, a plain cylinder and a plain torus', () => {
    const scope = new DisposeScope()
    try {
      for (const shape of [
        plainSphere(oc!, scope),
        plainCylinder(oc!, scope),
        plainTorus(oc!, scope),
      ]) {
        const result = reseatSeams(oc!, scope, shape, {})
        expect(result.changed).toBe(false)
        // The hot path allocates no replacement and hands the same handle back.
        expect(result.shape).toBe(shape)
      }
    } finally {
      scope.dispose()
    }
  }, 60_000)

  it('re-seats a torus cut across its seam', () => {
    const scope = new DisposeScope()
    try {
      const shape = torusCutAcrossSeam(oc!, scope)
      const torus = faceOfType(oc!, scope, shape, 'torus')!
      const before = volumeOfDefault(oc!, scope, shape)
      expect(seamEdges(oc!, scope, torus).length).toBeGreaterThanOrEqual(2)
      expect(isValid(oc!, scope, shape)).toBe(true)

      const result = reseatSeams(oc!, scope, shape, {})
      expect(result.changed).toBe(true)
      const rebuilt = scope.track(result.shape)
      closeVolume(before, volumeOfDefault(oc!, scope, rebuilt))
      expect(isValid(oc!, scope, rebuilt)).toBe(true)
      const rebuiltTorus = faceOfType(oc!, scope, rebuilt, 'torus')!
      // The seam no longer ends on the notch rim: its vertices (the seam's own
      // closed-edge vertex) touch no boundary edge.
      for (const seam of seamEdges(oc!, scope, rebuiltTorus)) {
        for (const vertex of verticesOf(oc!, scope, seam)) {
          const incident = openBoundary(oc!, scope, rebuiltTorus).filter((edge) =>
            verticesOf(oc!, scope, edge).some((v) => v.IsSame(vertex)),
          )
          expect(incident.length).toBeLessThan(2)
        }
      }
      // The notch now sits at the far side of the period: on the rebuilt
      // surface the seam is u=0 and every boundary pcurve stays well away from
      // it, which is what keeps the rim whole.
      const boundaryUs = openBoundary(oc!, scope, rebuiltTorus).flatMap((edge) => {
        const ad = scope.track(new oc!.BRepAdaptor_Curve2d_2(edge, rebuiltTorus))
        const p0 = scope.track(ad.Value(ad.FirstParameter()))
        const p1 = scope.track(ad.Value(ad.LastParameter()))
        return [p0.X(), p1.X()]
      })
      expect(boundaryUs.length).toBeGreaterThan(0)
      for (const u of boundaryUs) {
        const fromSeam = Math.min(
          ((u % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI),
          ((2 * Math.PI - (u % (2 * Math.PI))) % (2 * Math.PI)),
        )
        expect(fromSeam).toBeGreaterThan(0.2)
      }
    } finally {
      scope.dispose()
    }
  }, 60_000)

  it('leaves a wrap with no free gap alone, so the split stays pinned', () => {
    const scope = new DisposeScope()
    try {
      const shape = sphereWithNoFreeGap(oc!, scope)
      const sphere = faceOfType(oc!, scope, shape, 'sphere')!
      // The defect is present: the seam still ends on the groove rim.
      expect(seamEdges(oc!, scope, sphere).length).toBeGreaterThanOrEqual(2)
      const result = reseatSeams(oc!, scope, shape, {})
      expect(result.changed).toBe(false)
      expect(result.shape).toBe(shape)
      expect(isValid(oc!, scope, shape)).toBe(true)
    } finally {
      scope.dispose()
    }
  }, 60_000)

  it('leaves a face whose boundary carries a closed edge alone (phase 2)', () => {
    // The band's cap circles and far bore rim are closed edges shared with
    // neighbouring faces; moving their seam vertex is a topology rewrite. This
    // pins the accepted limitation in backlog.md.
    const scope = new DisposeScope()
    try {
      const shape = cylinderBandWithHole(oc!, scope)
      const band = faces(oc!, scope, shape).find((f) => {
        if (surfaceType(oc!, scope, f) !== oc!.GeomAbs_SurfaceType.GeomAbs_Cylinder.value) {
          return false
        }
        const cyl = scope.track(scope.track(new oc!.BRepAdaptor_Surface_2(f, true)).Cylinder())
        return Math.abs(cyl.Radius() - 10) < 1e-6
      })!
      expect(seamEdges(oc!, scope, band).length).toBeGreaterThanOrEqual(2)
      expect(openBoundary(oc!, scope, band).some((e) => verticesOf(oc!, scope, e).length === 1)).toBe(
        true,
      )
      const result = reseatSeams(oc!, scope, shape, {})
      expect(result.changed).toBe(false)
      expect(result.shape).toBe(shape)
      expect(isValid(oc!, scope, shape)).toBe(true)
    } finally {
      scope.dispose()
    }
  }, 60_000)

  it('keeps the pre-pass solid when the rebuild fails its guard', () => {
    // A deliberately flipped rebuild (the orientation rule broken) must be
    // rejected by the layer's guard, never adopted: the feature keeps the
    // sound, un-re-seated solid.
    const scope = new DisposeScope()
    try {
      const shape = sphereMinusSlot(oc!, scope)
      const before = volumeOfDefault(oc!, scope, shape)
      const flipped: CleanupPass = (oc2, s, input, options) => {
        const result = reseatSeams(oc2, s, input, options)
        if (!result.changed) return result
        return {
          ...result,
          shape: (result.shape as OccOrientableShape).Reversed(),
        }
      }
      const cleaned = runCleanup(
        oc!,
        scope,
        { shape },
        [{ name: 'reseatSeams', pass: flipped, guard: { validity: 'always' } }],
      )
      expect(cleaned.passes).toEqual([{ name: 'reseatSeams', status: 'rejected' }])
      expect(cleaned.shape).toBe(shape)
      expect(cleaned.changed).toBe(false)
      closeVolume(before, volumeOfDefault(oc!, scope, cleaned.shape))
      expect(isValid(oc!, scope, cleaned.shape)).toBe(true)
    } finally {
      scope.dispose()
    }
  }, 60_000)
})
