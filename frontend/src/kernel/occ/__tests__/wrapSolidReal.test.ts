// @vitest-environment node
//
// Real-OCC pins for the wrap builder (occ/wrapSolid.ts), grown from its spike.
// The spike settled the construction: no Sewing, no Geom_Conical/Spherical/
// ToroidalSurface and no Geom2d B-spline are bound in this build, but a solid
// RULED ThruSections between a base wire and its normal offset, both carrying
// p-curves on their analytic surfaces, caps itself on those very surfaces
// (cylinder, cone, sphere, torus) and builds a valid solid, including across
// the torus' v seam. A lone face's MakeThickSolid returned an empty solid and a
// hand-assembled shell (open loft + MakeFace caps) came back invalid, so
// neither is used. Hermite edges get their p-curves from a ShapeFix_Face pass on
// a MakeFace_21 face and stay IsSame. Volumes below are closed forms in the
// surface's own coordinates, so a wrong map, a skewed wall or a lost hole moves
// them.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import { volumeOf } from '../volume'
import { shapeIsValid } from '../booleans'
import { drainList } from '../disposeScope'
import { makeArcEdge, makeCircleEdge, makeFaceFromWire, makeLineEdge, makeWire, type Vec3 } from '../primitives'
import { wrapBuilder } from '../wrapSolid'
import { wrapMap, wrapFitTolerance, type WrapSurface } from '../../features/wrapMath'
import type { PlaneLike } from '../../features/shared/planes'
import type { OccModule, OccShape } from '../occTypes'

const oc = (await loadOcc()) as OccModule
const FRONT: PlaneLike = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }
const lift = (p: number[]): Vec3 => [p[0], p[1], 0]

function polygonFace(scope: DisposeScope, outer: number[][], holes: number[][][] = []): OccShape {
  const wireOf = (pts: number[][]): OccShape => {
    const edges = pts.map((p, i) => scope.track(makeLineEdge(oc, scope, lift(p), lift(pts[(i + 1) % pts.length]))))
    return scope.track(makeWire(oc, scope, edges, { requireClosed: true }))
  }
  return scope.track(makeFaceFromWire(oc, scope, wireOf(outer), holes.map(wireOf)))
}

function circleFace(scope: DisposeScope, cx: number, cy: number, r: number): OccShape {
  const edge = scope.track(makeCircleEdge(oc, scope, [cx, cy, 0], [0, 0, 1], [1, 0, 0], r))
  return scope.track(makeFaceFromWire(oc, scope, scope.track(makeWire(oc, scope, [edge], { requireClosed: true }))))
}

const rect = (cx: number, cy: number, w: number, l: number): number[][] => [
  [cx - w / 2, cy - l / 2], [cx + w / 2, cy - l / 2], [cx + w / 2, cy + l / 2], [cx - w / 2, cy + l / 2],
]

function build(scope: DisposeScope, surface: WrapSurface, face: OccShape, footprint: number[][], offset: number, concave = false) {
  const map = wrapMap({ surface, concave, plane: FRONT, footprint })
  const builder = wrapBuilder(oc, scope, face, FRONT, map, offset, wrapFitTolerance(20))
  const solid = scope.track(builder.Shape())
  return { builder, solid, volume: volumeOf(oc, scope, solid), valid: shapeIsValid(oc, scope, solid) }
}

function surfaceKinds(scope: DisposeScope, solid: OccShape): number[] {
  const E = oc.TopAbs_ShapeEnum
  const out: number[] = []
  const exp = scope.track(new oc.TopExp_Explorer_2(solid, E.TopAbs_FACE, E.TopAbs_SHAPE))
  for (; exp.More(); exp.Next()) {
    const f = scope.track(oc.TopoDS.Face_1(scope.track(exp.Current())))
    out.push(scope.track(new oc.BRepAdaptor_Surface_2(f, true)).GetType().value)
  }
  return out
}

const R = 10
const CYL: WrapSurface = { kind: 'cylinder', origin: [0, 0, 0], axis: [0, 1, 0], radius: R }
const rel = (a: number, b: number): number => Math.abs(a - b) / Math.abs(b)

describe.skipIf(!oc)('wrap builder (real OCC)', () => {
  it('a rectangle on a convex cylinder is the exact annular sector', () => {
    const scope = new DisposeScope()
    try {
      const W = 8, L = 12, h = 1
      const fp = rect(0, 0, W, L)
      const { volume, valid, solid } = build(scope, CYL, polygonFace(scope, fp), fp, h)
      expect(valid).toBe(true)
      expect(rel(volume, L * (W / (2 * R)) * ((R + h) ** 2 - R ** 2))).toBeLessThan(1e-6)
      // Caps on the analytic cylinders, four ruled walls.
      const S = oc.GeomAbs_SurfaceType
      const kinds = surfaceKinds(scope, solid)
      expect(kinds.filter((k) => k === S.GeomAbs_Cylinder.value)).toHaveLength(2)
      expect(kinds).toHaveLength(6)
    } finally {
      scope.dispose()
    }
  })

  it('a bore fills toward the axis by the same footprint', () => {
    const scope = new DisposeScope()
    try {
      const W = 8, L = 12, h = 1
      const fp = rect(0, 0, W, L)
      const { volume, valid } = build(scope, CYL, polygonFace(scope, fp), fp, -h, true)
      expect(valid).toBe(true)
      expect(rel(volume, L * (W / (2 * R)) * (R ** 2 - (R - h) ** 2))).toBeLessThan(1e-6)
    } finally {
      scope.dispose()
    }
  })

  it('a footprint turned 90 degrees in the sketch swaps around and along', () => {
    const scope = new DisposeScope()
    try {
      const W = 8, L = 12, h = 1
      const fp = rect(0, 0, L, W)
      const { volume } = build(scope, CYL, polygonFace(scope, fp), fp, h)
      expect(rel(volume, W * (L / (2 * R)) * ((R + h) ** 2 - R ** 2))).toBeLessThan(1e-6)
    } finally {
      scope.dispose()
    }
  })

  it('a hole in the loop stays a hole', () => {
    const scope = new DisposeScope()
    try {
      const h = 1
      const fp = rect(0, 0, 8, 12)
      const hole = rect(0, 0, 2, 4)
      const { volume, valid } = build(scope, CYL, polygonFace(scope, fp, [hole.slice().reverse()]), fp, h)
      expect(valid).toBe(true)
      const sector = (w: number, l: number): number => l * (w / (2 * R)) * ((R + h) ** 2 - R ** 2)
      expect(rel(volume, sector(8, 12) - sector(2, 4))).toBeLessThan(1e-6)
    } finally {
      scope.dispose()
    }
  })

  it('with two holes the caps and every wall the builder names are faces of the final solid', () => {
    const scope = new DisposeScope()
    try {
      const h = 1
      const fp = rect(0, 0, 8, 12)
      const holes = [rect(0, -3, 2, 2), rect(0, 3, 2, 2)].map((r) => r.slice().reverse())
      const face = polygonFace(scope, fp, holes)
      const { builder, solid, volume, valid } = build(scope, CYL, face, fp, h)
      expect(valid).toBe(true)
      const sector = (w: number, l: number): number => l * (w / (2 * R)) * ((R + h) ** 2 - R ** 2)
      expect(rel(volume, sector(8, 12) - 2 * sector(2, 2))).toBeLessThan(1e-6)
      const E = oc.TopAbs_ShapeEnum
      const solidFaces: OccShape[] = []
      const fexp = scope.track(new oc.TopExp_Explorer_2(solid, E.TopAbs_FACE, E.TopAbs_SHAPE))
      for (; fexp.More(); fexp.Next()) solidFaces.push(scope.track(oc.TopoDS.Face_1(scope.track(fexp.Current()))))
      const inSolid = (f: OccShape): boolean => solidFaces.some((s) => (s as unknown as { IsSame(o: OccShape): boolean }).IsSame(f))
      // Chaining the per-cut maps stopped one cut short and named faces the
      // second cut had already replaced.
      for (const cap of [builder.FirstShape?.(), builder.LastShape?.()]) {
        expect(cap).toBeDefined()
        expect(inSolid(cap as OccShape)).toBe(true)
      }
      const eexp = scope.track(new oc.TopExp_Explorer_2(face, E.TopAbs_EDGE, E.TopAbs_SHAPE))
      let walls = 0
      for (; eexp.More(); eexp.Next()) {
        const edge = scope.track(oc.TopoDS.Edge_1(scope.track(eexp.Current())))
        const generated = drainList(scope, builder.Generated(edge))
        expect(generated).toHaveLength(1)
        expect(inSolid(generated[0])).toBe(true)
        walls++
      }
      expect(walls).toBe(12)
    } finally {
      scope.dispose()
    }
  })

  it('a circle is a Hermite chain within the fit tolerance', () => {
    const scope = new DisposeScope()
    try {
      const rc = 3, h = 1
      const fp = Array.from({ length: 32 }, (_, i) => [rc * Math.cos((i * Math.PI) / 16), rc * Math.sin((i * Math.PI) / 16)])
      const { volume, valid, solid } = build(scope, CYL, circleFace(scope, 0, 0, rc), fp, h)
      expect(valid).toBe(true)
      // The (theta, z) area is A / R, so V = (A / R) ((R + h)^2 - R^2) / 2.
      expect(rel(volume, ((Math.PI * rc * rc) / R) * (((R + h) ** 2 - R ** 2) / 2))).toBeLessThan(1e-5)
      const S = oc.GeomAbs_SurfaceType
      expect(surfaceKinds(scope, solid).filter((k) => k === S.GeomAbs_Cylinder.value)).toHaveLength(2)
    } finally {
      scope.dispose()
    }
  })

  it('a slot mixes exact p-curve lines with Hermite arcs', () => {
    const scope = new DisposeScope()
    try {
      const h = 0.5
      const a = makeLineEdge(oc, scope, [-3, -1, 0], [3, -1, 0])
      const b = makeArcEdge(oc, scope, [3, 0, 0], [0, 0, 1], [1, 0, 0], 1, -Math.PI / 2, Math.PI / 2)
      const c = makeLineEdge(oc, scope, [3, 1, 0], [-3, 1, 0])
      const d = makeArcEdge(oc, scope, [-3, 0, 0], [0, 0, 1], [1, 0, 0], 1, Math.PI / 2, (3 * Math.PI) / 2)
      const wire = scope.track(makeWire(oc, scope, [a, b, c, d].map((e) => scope.track(e)), { requireClosed: true }))
      const face = scope.track(makeFaceFromWire(oc, scope, wire))
      const fp = [[-4, -1], [4, -1], [4, 1], [-4, 1]]
      const { volume, valid, builder } = build(scope, CYL, face, fp, h)
      expect(valid).toBe(true)
      const area = 12 + Math.PI
      expect(rel(volume, (area / R) * (((R + h) ** 2 - R ** 2) / 2))).toBeLessThan(1e-5)
      // Every edge of the profile face narrates exactly one wall: the lineage
      // asks with the face's own edges.
      const E = oc.TopAbs_ShapeEnum
      const exp = scope.track(new oc.TopExp_Explorer_2(face, E.TopAbs_EDGE, E.TopAbs_SHAPE))
      let n = 0
      for (; exp.More(); exp.Next()) {
        const edge = scope.track(oc.TopoDS.Edge_1(scope.track(exp.Current())))
        expect(drainList(scope, builder.Generated(edge))).toHaveLength(1)
        n++
      }
      expect(n).toBe(4)
    } finally {
      scope.dispose()
    }
  })

  it('a cone keeps the closed-form volume about the reference parallel', () => {
    const scope = new DisposeScope()
    try {
      const alpha = (15 * Math.PI) / 180
      const cone: WrapSurface = { kind: 'cone', origin: [0, 0, 0], axis: [0, 1, 0], refRadius: 10, semiAngle: alpha }
      const W = 6, L = 4, h = 0.8
      const fp = rect(0, 3, W, L)
      const { volume, valid } = build(scope, cone, polygonFace(scope, fp), fp, h)
      expect(valid).toBe(true)
      // V = du * L * h * (r0 + h cos / 2) with du = W / r0 the angular span.
      const r0 = 10 + 3 * Math.tan(alpha)
      expect(rel(volume, (W / r0) * L * h * (r0 + (h * Math.cos(alpha)) / 2))).toBeLessThan(1e-6)
    } finally {
      scope.dispose()
    }
  })

  it('a disk on a sphere is the spherical cap shell', () => {
    const scope = new DisposeScope()
    try {
      const sphere: WrapSurface = { kind: 'sphere', center: [0, 0, 0], radius: R }
      const rho = 4, h = 1
      const fp = Array.from({ length: 32 }, (_, i) => [rho * Math.cos((i * Math.PI) / 16), rho * Math.sin((i * Math.PI) / 16)])
      const { volume, valid, solid } = build(scope, sphere, circleFace(scope, 0, 0, rho), fp, h)
      expect(valid).toBe(true)
      const omega = 2 * Math.PI * (1 - Math.cos(rho / R))
      expect(rel(volume, (omega / 3) * ((R + h) ** 3 - R ** 3))).toBeLessThan(1e-5)
      const S = oc.GeomAbs_SurfaceType
      expect(surfaceKinds(scope, solid).filter((k) => k === S.GeomAbs_Sphere.value)).toHaveLength(2)
    } finally {
      scope.dispose()
    }
  })

  it('a rectangle across the torus v seam is the closed-form tube sector', () => {
    const scope = new DisposeScope()
    try {
      const torus: WrapSurface = { kind: 'torus', origin: [0, 0, 0], axis: [0, 1, 0], majorRadius: 20, minorRadius: 5 }
      const W = 6, L = 4, h = 1
      const fp = rect(0, 0, W, L)
      const { volume, valid } = build(scope, torus, polygonFace(scope, fp), fp, h)
      expect(valid).toBe(true)
      const r = 5, r0 = 25
      const du = W / r0
      const phiMax = L / 2 / r
      const expected = du * (20 * 2 * phiMax * (((r + h) ** 2 - r ** 2) / 2) + 2 * Math.sin(phiMax) * (((r + h) ** 3 - r ** 3) / 3))
      expect(rel(volume, expected)).toBeLessThan(1e-6)
    } finally {
      scope.dispose()
    }
  })
})
