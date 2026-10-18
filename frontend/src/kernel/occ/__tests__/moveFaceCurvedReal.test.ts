// @vitest-environment node
//
// Gated real-OCC test for the curved move-face core (occ/moveFace.ts with its
// per-surface descriptors in occ/moveFaceSurfaces.ts): a cylinder, cone, sphere
// or torus face moves as a uniform offset of its surface, the bounding faces
// extend, the seam and degenerated edges are skipped and the face may vanish.
// Every volume is an analytic formula; the planar regression lives in
// moveFaceReal.test.ts. Skips when opencascade.js is absent.
import { describe, it, expect } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import { volumeOf } from '../volume'
import { canonicalFaces, canonicalEdges } from '../bodyNames'
import {
  makeBox,
  makeBoxAt,
  faceCentroid,
  type Vec3,
} from '../primitives'
import { applyMoveFace, faceNormalAndCentroid, MoveFaceRefusal } from '../moveFace'
import { valueWithinTolerance } from '../measureTolerance'
import type { OccModule, OccShape } from '../occTypes'

const oc = await loadOcc()

const PI = Math.PI

/** Composite Simpson over [a, b]. */
function simpson(a: number, b: number, n: number, f: (x: number) => number): number {
  const h = (b - a) / n
  let total = f(a) + f(b)
  for (let i = 1; i < n; i++) total += (i % 2 ? 4 : 2) * f(a + i * h)
  return (total * h) / 3
}

/** The volume a drill of radius `drillR` along the X axis (at mid height)
 *  removes from a tube's wall between `innerR` and `outerR`: the drill disc's
 *  cross-section swept by the annulus's chord length at each height. No closed
 *  form, so it is integrated (the wall's chord varies with y). */
function drilledTubeHole(outerR: number, innerR: number, drillR: number): number {
  const half = simpson(0, PI / 2, 2000, (t) => {
    const y = drillR * Math.sin(t)
    return (2 * drillR * Math.cos(t)) * 2 * (Math.sqrt(outerR * outerR - y * y) - Math.sqrt(innerR * innerR - y * y)) * drillR * Math.cos(t)
  })
  return 2 * half
}

const frustumV = (r1: number, r2: number, h: number): number => (PI * h / 3) * (r1 * r1 + r1 * r2 + r2 * r2)
const coneV = (r: number, h: number): number => (PI * r * r * h) / 3
const ballV = (r: number): number => (4 / 3) * PI * r * r * r
const torusV = (major: number, minor: number): number => 2 * PI * PI * major * minor * minor

describe.skipIf(!oc)('move face on curved surfaces (real OCC)', () => {
  const occ = oc as OccModule
  const S = occ.GeomAbs_SurfaceType

  // ─── fixture builders ───

  const ax2 = (scope: DisposeScope, origin: Vec3, dir: Vec3): OccShape =>
    scope.track(new occ.gp_Ax2_3(
      scope.track(new occ.gp_Pnt_3(origin[0], origin[1], origin[2])),
      scope.track(new occ.gp_Dir_4(dir[0], dir[1], dir[2])),
    ))

  const ax2z = (scope: DisposeScope, x = 0, y = 0, z = 0): OccShape => ax2(scope, [x, y, z], [0, 0, 1])

  const cylAx = (scope: DisposeScope, origin: Vec3, dir: Vec3, r: number, h: number): OccShape =>
    scope.track(new occ.BRepPrimAPI_MakeCylinder_3(ax2(scope, origin, dir), r, h).Shape())

  const cylinderAt = (scope: DisposeScope, x: number, y: number, z: number, r: number, h: number): OccShape =>
    cylAx(scope, [x, y, z], [0, 0, 1], r, h)

  const cone = (scope: DisposeScope, r1: number, r2: number, h: number): OccShape =>
    scope.track(new occ.BRepPrimAPI_MakeCone_3(ax2z(scope), r1, r2, h).Shape())

  const ball = (scope: DisposeScope, centre: Vec3, r: number): OccShape =>
    scope.track(new occ.BRepPrimAPI_MakeSphere_5(
      scope.track(new occ.gp_Pnt_3(centre[0], centre[1], centre[2])), r,
    ).Shape())

  const torus = (scope: DisposeScope, major: number, minor: number): OccShape =>
    scope.track(new occ.BRepPrimAPI_MakeTorus_5(ax2z(scope), major, minor).Shape())

  function boolBodies(scope: DisposeScope, a: OccShape, b: OccShape, op: 'fuse' | 'cut'): OccShape {
    const algo = scope.track(op === 'fuse' ? new occ.BRepAlgoAPI_Fuse_1() : new occ.BRepAlgoAPI_Cut_1())
    const args = scope.track(new occ.TopTools_ListOfShape_1())
    args.Append_1(a)
    const tools = scope.track(new occ.TopTools_ListOfShape_1())
    tools.Append_1(b)
    algo.SetArguments(args)
    algo.SetTools(tools)
    algo.Build()
    return scope.track(algo.Shape())
  }

  // ─── face pickers ───

  const kindOf = (scope: DisposeScope, f: OccShape): number =>
    scope.track(new occ.BRepAdaptor_Surface_2(f, true)).GetType().value

  const facesOf = (scope: DisposeScope, body: OccShape): OccShape[] =>
    canonicalFaces(occ, scope, body) as OccShape[]

  // The one face of the requested analytic kind, or a clear failure.
  function pickKind(scope: DisposeScope, body: OccShape, kind: number): OccShape {
    const hit = facesOf(scope, body).filter((f) => kindOf(scope, f) === kind)
    if (hit.length !== 1) throw new Error(`expected 1 face of the kind, got ${hit.length}`)
    return hit[0]
  }

  const cylKind = S.GeomAbs_Cylinder.value
  const coneKind = S.GeomAbs_Cone.value
  const sphereKind = S.GeomAbs_Sphere.value
  const torusKind = S.GeomAbs_Torus.value

  const moved = (scope: DisposeScope, body: OccShape, face: OccShape, d: number): OccShape =>
    applyMoveFace(occ, scope, body, face, d).shape

  function expectVolume(scope: DisposeScope, shape: OccShape, expected: number): void {
    const v = volumeOf(occ, scope, shape)
    expect(valueWithinTolerance(v, expected), `volume ${v} vs ${expected}`).toBe(true)
  }

  const cylindricalFaces = (scope: DisposeScope, body: OccShape): number =>
    facesOf(scope, body).filter((f) => kindOf(scope, f) === cylKind).length

  // ─── cylinder ───

  it('cylinder body lateral wall: +2 grows to r7, -2 shrinks to r3', () => {
    for (const [d, want] of [[2, PI * 49 * 10], [-2, PI * 9 * 10]] as const) {
      const scope = new DisposeScope()
      try {
        const body = scope.track(cylinderAt(scope, 0, 0, 0, 5, 10))
        const wall = pickKind(scope, body, cylKind)
        expectVolume(scope, moved(scope, body, wall, d), want)
      } finally { scope.dispose() }
    }
  })

  it('a full cylinder face moves without a tangent refusal (its seam is skipped)', () => {
    const scope = new DisposeScope()
    try {
      const body = scope.track(cylinderAt(scope, 0, 0, 0, 5, 10))
      const wall = pickKind(scope, body, cylKind)
      // The face carries a seam (and both circles); a naive tangent check would
      // refuse it. Reaching a volume is the assertion.
      const out = moved(scope, body, wall, 2)
      expectVolume(scope, out, PI * 49 * 10)
      expect(facesOf(scope, out)).toHaveLength(3)
    } finally { scope.dispose() }
  })

  it('boss wall on a 40x40x10 box: +2 / -2 grow and shrink the boss, -5 removes it', () => {
    const build = (scope: DisposeScope): OccShape =>
      boolBodies(scope, scope.track(makeBox(occ, scope, 40, 40, 10)), cylinderAt(scope, 20, 20, 10, 5, 10), 'fuse')
    for (const [d, want, cylFaces] of [
      [2, 16000 + PI * 49 * 10, 1],
      [-2, 16000 + PI * 9 * 10, 1],
      [-5, 16000, 0],
    ] as const) {
      const scope = new DisposeScope()
      try {
        const body = build(scope)
        const wall = pickKind(scope, body, cylKind)
        const out = moved(scope, body, wall, d)
        expectVolume(scope, out, want)
        expect(cylindricalFaces(scope, out)).toBe(cylFaces)
      } finally { scope.dispose() }
    }
  })

  it('through bore r5 in a 40x40x10 box: wall +2 closes it to r3, +5 fills it', () => {
    const build = (scope: DisposeScope): OccShape =>
      boolBodies(scope, scope.track(makeBox(occ, scope, 40, 40, 10)), cylinderAt(scope, 20, 20, -5, 5, 20), 'cut')
    for (const [d, want, cylFaces] of [
      [2, 16000 - PI * 9 * 10, 1],
      [5, 16000, 0],
    ] as const) {
      const scope = new DisposeScope()
      try {
        const body = build(scope)
        const wall = pickKind(scope, body, cylKind)
        const out = moved(scope, body, wall, d)
        expectVolume(scope, out, want)
        expect(cylindricalFaces(scope, out)).toBe(cylFaces)
      } finally { scope.dispose() }
    }
  })

  it('blind bore r5 d3: wall -1 widens the hole and its floor', () => {
    const scope = new DisposeScope()
    try {
      const body = boolBodies(
        scope,
        scope.track(makeBox(occ, scope, 40, 40, 10)),
        cylinderAt(scope, 20, 20, 7, 5, 3),
        'cut',
      )
      const wall = pickKind(scope, body, cylKind)
      expectVolume(scope, moved(scope, body, wall, -1), 16000 - PI * 36 * 3)
    } finally { scope.dispose() }
  })

  // The pipe fixture builds two booleans and the move runs twice; it needs
  // more than the default 5 s on a loaded box.
  it('radial hole through a pipe wall: the inner loop follows the moved wall', () => {
    // Pipe r10/r6, drilled across by a r1.5 hole at mid height. Moving the
    // outer wall follows the hole's mouth: the hole/boss rule keeps the loop's
    // column out of the added material on a growth and inside the removed
    // material on a shrink.
    const build = (scope: DisposeScope): OccShape => {
      const pipe = boolBodies(
        scope,
        cylinderAt(scope, 0, 0, 0, 10, 10),
        cylinderAt(scope, 0, 0, -1, 6, 12),
        'cut',
      )
      return boolBodies(scope, pipe, cylAx(scope, [-11, 0, 5], [1, 0, 0], 1.5, 22), 'cut')
    }
    const outerWall = (scope: DisposeScope, body: OccShape): OccShape =>
      facesOf(scope, body).find((f) => {
        if (kindOf(scope, f) !== cylKind) return false
        const cyl = scope.track(new occ.BRepAdaptor_Surface_2(f, true)).Cylinder()
        return Math.abs(scope.track(cyl).Radius() - 10) < 1e-9
      }) as OccShape
    const net = (outerR: number): number => PI * (outerR * outerR - 36) * 10 - drilledTubeHole(outerR, 6, 1.5)
    for (const [d, want] of [[1, net(11)], [-1, net(9)]] as const) {
      const scope = new DisposeScope()
      try {
        const body = build(scope)
        expectVolume(scope, moved(scope, body, outerWall(scope, body), d), want)
      } finally { scope.dispose() }
    }
  }, 30000)

  it('a radial boss on a tube wall (a concave loop): the root follows the wall', () => {
    // A r2 boss along +X fused onto a r10/r6 tube's outer wall. Its root on the
    // wall is a Concave inner loop, so the hole/boss rule fuses the root column
    // on a growth (the wall grows past the boss) and keeps it on a shrink (the
    // boss stays attached and reaches further in). The boss's protrusion is a
    // numerical integral: the wall's chord varies with y.
    const build = (scope: DisposeScope): OccShape => {
      const pipe = boolBodies(
        scope,
        cylinderAt(scope, 0, 0, 0, 10, 10),
        cylinderAt(scope, 0, 0, -1, 6, 12),
        'cut',
      )
      return boolBodies(scope, pipe, cylAx(scope, [8, 0, 5], [1, 0, 0], 2, 6), 'fuse')
    }
    const bossBeyondWall = (wallR: number): number => {
      const half = simpson(0, PI / 2, 2000, (t) => {
        const y = 2 * Math.sin(t)
        return (2 * 2 * Math.cos(t)) * (14 - Math.sqrt(wallR * wallR - y * y)) * 2 * Math.cos(t)
      })
      return 2 * half
    }
    const outerWall = (scope: DisposeScope, body: OccShape): OccShape =>
      facesOf(scope, body).find((f) => {
        if (kindOf(scope, f) !== cylKind) return false
        const cyl = scope.track(new occ.BRepAdaptor_Surface_2(f, true)).Cylinder()
        return Math.abs(scope.track(cyl).Radius() - 10) < 1e-9
      }) as OccShape
    for (const [d, want] of [
      [1, PI * (121 - 36) * 10 + bossBeyondWall(11)],
      [-1, PI * (81 - 36) * 10 + bossBeyondWall(9)],
    ] as const) {
      const scope = new DisposeScope()
      try {
        const body = build(scope)
        // The root loop is a cylinder-cylinder intersection, so the boolean's
        // faces there carry tolerance-level slop; 1e-5 relative is the honest
        // budget (the measured deviation is 1.8e-6).
        const v = volumeOf(occ, scope, moved(scope, body, outerWall(scope, body), d))
        expect(valueWithinTolerance(v, want, { rel: 1e-5, abs: 1e-6 }), `volume ${v} vs ${want}`).toBe(true)
      } finally { scope.dispose() }
    }
  }, 30000)

  it('a filleted cylinder top edge is still refused as a tangent neighbour', () => {
    const scope = new DisposeScope()
    try {
      const body0 = scope.track(cylinderAt(scope, 0, 0, 0, 5, 10))
      const mk = scope.track(new occ.BRepFilletAPI_MakeFillet(body0, occ.ChFi3d_FilletShape.ChFi3d_Rational))
      for (const e of canonicalEdges(occ, scope, body0)) {
        const ad = scope.track(new occ.BRepAdaptor_Curve_2(e as OccShape))
        if (ad.GetType().value !== occ.GeomAbs_CurveType.GeomAbs_Circle.value) continue
        const circ = scope.track(ad.Circle())
        const loc = scope.track(circ.Location())
        if (Math.abs(loc.Z() - 10) < 1e-6) mk.Add_2(1, e as OccShape)
      }
      mk.Build()
      const body = scope.track(mk.Shape())
      const wall = pickKind(scope, body, cylKind)
      let threw: unknown = null
      try { moved(scope, body, wall, 2) } catch (e) { threw = e }
      expect(threw).toBeInstanceOf(MoveFaceRefusal)
      expect((threw as Error).message).toContain('tangent')
    } finally { scope.dispose() }
  })

  // ─── cone ───

  it('frustum r10->5 h10 slant face: +1 / -1 are exact parallel frustums', () => {
    const semi = Math.atan(0.5)
    const grow = 1 / Math.cos(semi)
    for (const [d, want] of [
      [1, frustumV(10 + grow, 5 + grow, 10)],
      [-1, frustumV(10 - grow, 5 - grow, 10)],
    ] as const) {
      const scope = new DisposeScope()
      try {
        const body = scope.track(cone(scope, 10, 5, 10))
        const slant = pickKind(scope, body, coneKind)
        expectVolume(scope, moved(scope, body, slant, d), want)
      } finally { scope.dispose() }
    }
  }, 30000)

  it('full cone r10 h10 slant face: +1 / -1 grow and shrink the cone about its base', () => {
    // A 45 degree cone: the parallel cone's apex shifts by d/sin(semi) and the
    // base radius at the plane grows by d/cos(semi), the same shift at 45.
    const semi = Math.atan(1)
    const shift = 1 / Math.sin(semi)
    for (const [d, want] of [
      [1, coneV(10 + shift, 10 + shift)],
      [-1, coneV(10 - shift, 10 - shift)],
    ] as const) {
      const scope = new DisposeScope()
      try {
        const body = scope.track(cone(scope, 10, 0, 10))
        const slant = pickKind(scope, body, coneKind)
        expectVolume(scope, moved(scope, body, slant, d), want)
      } finally { scope.dispose() }
    }
  }, 30000)

  it('a cone move that takes the ref radius past zero is refused by name', () => {
    // The frustum's ref radius is 10 and cos(semi) = 0.894, so moving the slant
    // face in by 9 drives the parallel cone's ref radius to -0.065: the moved
    // surface is the mirrored nappe and the offset has no same-nappe meaning.
    const scope = new DisposeScope()
    try {
      const body = scope.track(cone(scope, 10, 5, 10))
      const slant = pickKind(scope, body, coneKind)
      let threw: unknown = null
      try { moved(scope, body, slant, -9) } catch (e) { threw = e }
      expect(threw).toBeInstanceOf(MoveFaceRefusal)
      expect((threw as Error).message).toContain('past its apex')
    } finally { scope.dispose() }
  })

  it('frustum slant face moved past the top apex: the top part of the face vanishes', () => {
    // r10->5 h10: the apex sits at z=20 (tan = 0.5). Moving the slant face in
    // by 6 takes the moved apex to 6.584 in the face's own extent, so the
    // result is the small cone below it, not an error.
    const semi = Math.atan(0.5)
    const shift = 6 / Math.sin(semi)
    const apexZ = 20 - shift
    const baseR = apexZ * Math.tan(semi)
    const scope = new DisposeScope()
    try {
      const body = scope.track(cone(scope, 10, 5, 10))
      const slant = pickKind(scope, body, coneKind)
      expectVolume(scope, moved(scope, body, slant, -6), coneV(baseR, apexZ))
    } finally { scope.dispose() }
  })

  // ─── sphere ───

  it('hemispherical dome on a plane: +1 / -1 grow and shrink it, -r removes it', () => {
    const build = (scope: DisposeScope): OccShape => {
      const sphere = ball(scope, [0, 0, 0], 5)
      return boolBodies(scope, sphere, scope.track(makeBoxAt(occ, scope, [-10, -10, -10], 20, 20, 10)), 'cut')
    }
    for (const [d, want] of [
      [1, ballV(6) / 2],
      [-1, ballV(4) / 2],
      [-5, 0],
    ] as const) {
      const scope = new DisposeScope()
      try {
        const body = build(scope)
        const dome = pickKind(scope, body, sphereKind)
        expectVolume(scope, moved(scope, body, dome, d), want)
      } finally { scope.dispose() }
    }
  })

  // ─── torus ───

  it('torus upper half bounded by the z=0 plane: +-0.5 grow and shrink the tube', () => {
    const build = (scope: DisposeScope): OccShape => {
      const tor = torus(scope, 10, 2)
      return boolBodies(scope, tor, scope.track(makeBoxAt(occ, scope, [-20, -20, -20], 40, 40, 20)), 'cut')
    }
    for (const [d, want] of [
      [0.5, torusV(10, 2.5) / 2],
      [-0.5, torusV(10, 1.5) / 2],
    ] as const) {
      const scope = new DisposeScope()
      try {
        const body = build(scope)
        const tube = pickKind(scope, body, torusKind)
        expectVolume(scope, moved(scope, body, tube, d), want)
      } finally { scope.dispose() }
    }
  }, 30000)

  it('a wall moved onto a coincident existing wall merges into it', () => {
    // The plan's coincident-target risk: the r5 wall grows onto the r7 wall of
    // a stepped shaft and the clean step unifies the two, so the moved face's
    // UUID is absorbed by the target's (the pick's query goes stale, geometry
    // is exact). Pinned so a change in the merge cannot pass silently.
    const scope = new DisposeScope()
    try {
      const ax2 = (z: number): OccShape => scope.track(new occ.gp_Ax2_3(
        scope.track(new occ.gp_Pnt_3(0, 0, z)), scope.track(new occ.gp_Dir_4(0, 0, 1)),
      ))
      const cyl = (z: number, r: number, h: number): OccShape =>
        scope.track(new occ.BRepPrimAPI_MakeCylinder_3(ax2(z), r, h).Shape())
      const body = scope.track(boolBodies(scope, cyl(0, 7, 10), cyl(10, 5, 10), 'fuse'))
      const small = facesOf(scope, body).find((f) => {
        if (kindOf(scope, f) !== cylKind) return false
        const c = scope.track(new occ.BRepAdaptor_Surface_2(f, true)).Cylinder()
        return Math.abs(scope.track(c).Radius() - 5) < 1e-9
      }) as OccShape
      const out = moved(scope, body, small, 2)
      expectVolume(scope, out, PI * 49 * 20)
      expect(facesOf(scope, out)).toHaveLength(3)
    } finally { scope.dispose() }
  })

  it('a torus move that would pass the major radius is refused by name', () => {
    const scope = new DisposeScope()
    try {
      const tor = torus(scope, 10, 2)
      const tube = pickKind(scope, tor, torusKind)
      let threw: unknown = null
      try { moved(scope, tor, tube, 9) } catch (e) { threw = e }
      expect(threw).toBeInstanceOf(MoveFaceRefusal)
      expect((threw as Error).message).toContain('major radius')
    } finally { scope.dispose() }
  })

  // ─── refusals and the handle ───

  it('refuses a freeform face by surface name', () => {
    const scope = new DisposeScope()
    try {
      // A Bezier-capped D-shape prism: the curved side is a non-analytic face.
      const arc = scope.track((() => {
        const arr = scope.track(new occ.TColgp_Array1OfPnt_2(1, 3))
        arr.SetValue(1, scope.track(new occ.gp_Pnt_3(0, 0, 0)))
        arr.SetValue(2, scope.track(new occ.gp_Pnt_3(5, -3, 0)))
        arr.SetValue(3, scope.track(new occ.gp_Pnt_3(10, 0, 0)))
        return new occ.Handle_Geom_Curve_2(scope.track(new occ.Geom_BezierCurve_1(arr)))
      })())
      const line = scope.track(new occ.BRepBuilderAPI_MakeEdge_3(
        scope.track(new occ.gp_Pnt_3(10, 0, 0)), scope.track(new occ.gp_Pnt_3(0, 0, 0)),
      ).Edge()
      )
      const wireBuilder = scope.track(new occ.BRepBuilderAPI_MakeWire_1())
      wireBuilder.Add_1(scope.track(new occ.BRepBuilderAPI_MakeEdge_24(arc).Edge()))
      wireBuilder.Add_1(line)
      const faceBuilder = scope.track(new occ.BRepBuilderAPI_MakeFace_15(scope.track(wireBuilder.Wire()), true))
      const profile = scope.track(faceBuilder.Face())
      const body = scope.track(new occ.BRepPrimAPI_MakePrism_1(
        profile, scope.track(new occ.gp_Vec_4(0, 0, 5)), true, true,
      ).Shape())
      const freeform = facesOf(scope, body).find((f) => {
        const t = kindOf(scope, f)
        return t !== S.GeomAbs_Plane.value
      }) as OccShape
      expect(freeform).toBeDefined()
      let threw: unknown = null
      try { moved(scope, body, freeform, 1) } catch (e) { threw = e }
      expect(threw).toBeInstanceOf(MoveFaceRefusal)
      expect((threw as Error).message).toContain('cannot move a SurfaceOfExtrusion face')
    } finally { scope.dispose() }
  })

  it('the handle anchor of a full cylinder face lies on the face with a radial normal', () => {
    const scope = new DisposeScope()
    try {
      const body = scope.track(cylinderAt(scope, 0, 0, 0, 5, 10))
      const wall = pickKind(scope, body, cylKind)
      const { normal, centroid } = faceNormalAndCentroid(occ, scope, wall)
      // The anchor is ON the face: 5 from the axis, 5 up its height.
      expect(Math.hypot(centroid[0], centroid[1])).toBeCloseTo(5, 6)
      expect(centroid[2]).toBeCloseTo(5, 6)
      // The normal is the outward radial direction: unit, axial component 0.
      expect(Math.hypot(normal[0], normal[1], normal[2])).toBeCloseTo(1, 9)
      expect(normal[2]).toBeCloseTo(0, 9)
      expect((normal[0] * centroid[0] + normal[1] * centroid[1]) / 5).toBeCloseTo(1, 9)
    } finally { scope.dispose() }
  })

  it('the planar path is unchanged: the box top still moves by volume', () => {
    const scope = new DisposeScope()
    try {
      const body = scope.track(makeBox(occ, scope, 10, 10, 10))
      const top = facesOf(scope, body).find((f) => {
        const c = faceCentroid(occ, scope, f)
        return kindOf(scope, f) === S.GeomAbs_Plane.value && Math.abs(c[2] - 10) < 1e-9
      }) as OccShape
      expectVolume(scope, moved(scope, body, top, 5), 1500)
    } finally { scope.dispose() }
  })
})
