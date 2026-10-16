// @vitest-environment node
//
// Gated real-OCC test for the move-face geometric core (occ/moveFace.ts): the
// slab/split construction, the cell-selection rule (outer wire + inner
// hole/boss loop), and every guard. Primitives are built directly in OCC (no
// document) and asserted against analytic volumes through the shared measure
// tolerance. A change to the construction that moves a volume fails here.
//
// Skips when opencascade.js is absent.
import { describe, it, expect } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import { volumeOf } from '../volume'
import { canonicalFaces, canonicalEdges } from '../bodyNames'
import {
  makeBox,
  makeBoxAt,
  makeBezierEdge,
  makeLineEdge,
  makeWire,
  makeFaceFromWire,
  makePrism,
  faceCentroid,
  faceNormal,
  type Vec3,
} from '../primitives'
import { applyMoveFace, moveFaceCells, extendNeighbourFace, classifyFaceEdges, neighbourSurface, MoveFaceRefusal } from '../moveFace'
import { valueWithinTolerance } from '../measureTolerance'
import type { OccModule, OccShape } from '../occTypes'

const oc = await loadOcc()

const PI = Math.PI
const frustumV = (r1: number, r2: number, h: number): number => (PI * h / 3) * (r1 * r1 + r1 * r2 + r2 * r2)
const coneV = (r: number, h: number): number => (PI * r * r * h) / 3

describe.skipIf(!oc)('moveFaceCells / applyMoveFace (real OCC)', () => {
  let occ: OccModule
  if (oc) occ = oc

  // ─── fixture builders ───

  const ax2z = (scope: DisposeScope, x = 0, y = 0, z = 0): OccShape =>
    scope.track(new occ.gp_Ax2_3(
      scope.track(new occ.gp_Pnt_3(x, y, z)),
      scope.track(new occ.gp_Dir_4(0, 0, 1)),
    ))

  const cone = (scope: DisposeScope, r1: number, r2: number, h: number): OccShape =>
    scope.track(new occ.BRepPrimAPI_MakeCone_3(ax2z(scope), r1, r2, h).Shape())

  const cylinderAt = (scope: DisposeScope, x: number, y: number, z: number, r: number, h: number): OccShape =>
    scope.track(new occ.BRepPrimAPI_MakeCylinder_3(ax2z(scope, x, y, z), r, h).Shape())

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

  // A 10-box with 2mm chamfers on its four top edges.
  function chamferedBox(scope: DisposeScope, size = 10, dist = 2): OccShape {
    const body = scope.track(makeBox(occ, scope, size, size, size))
    const mk = scope.track(new occ.BRepFilletAPI_MakeChamfer(body))
    let topZ = -Infinity
    for (const f of canonicalFaces(occ, scope, body)) topZ = Math.max(topZ, faceCentroid(occ, scope, f as OccShape)[2])
    for (const e of canonicalEdges(occ, scope, body)) {
      const vs = vertexZ(scope, e as OccShape)
      if (vs.length === 2 && vs.every((z) => Math.abs(z - topZ) < 1e-6)) mk.Add_2(dist, e as OccShape)
    }
    mk.Build()
    return scope.track(mk.Shape())
  }

  function vertexZ(scope: DisposeScope, edge: OccShape): number[] {
    const exp = scope.track(new occ.TopExp_Explorer_2(edge, occ.TopAbs_ShapeEnum.TopAbs_VERTEX, occ.TopAbs_ShapeEnum.TopAbs_SHAPE))
    const out: number[] = []
    for (; exp.More(); exp.Next()) {
      const v = scope.track(occ.TopoDS.Vertex_1(scope.track(exp.Current())))
      out.push(scope.track(occ.BRep_Tool.Pnt(v)).Z())
    }
    return out
  }

  // A 10-box with a 2mm-radius fillet on one top edge (a tangent neighbour).
  function filletedBox(scope: DisposeScope): OccShape {
    const body = scope.track(makeBox(occ, scope, 10, 10, 10))
    const mk = scope.track(new occ.BRepFilletAPI_MakeFillet(body, occ.ChFi3d_FilletShape.ChFi3d_Rational))
    const top = canonicalEdges(occ, scope, body).find((e) => {
      const vs = vertexZ(scope, e as OccShape)
      return vs.length === 2 && vs.every((z) => Math.abs(z - 10) < 1e-6)
    })
    mk.Add_2(2, top as OccShape)
    mk.Build()
    return scope.track(mk.Shape())
  }

  // A U channel: 30x10x4 base with 10x10x6 arms at x 0..10 and 20..30.
  function uChannel(scope: DisposeScope): OccShape {
    const base = scope.track(makeBoxAt(occ, scope, [0, 0, 0], 30, 10, 4))
    const left = scope.track(makeBoxAt(occ, scope, [0, 0, 4], 10, 10, 6))
    const right = scope.track(makeBoxAt(occ, scope, [20, 0, 4], 10, 10, 6))
    return scope.track(boolBodies(scope, boolBodies(scope, base, left, 'fuse'), right, 'fuse'))
  }

  // A 10-box with a blind hole r2 d3 (floor at z=7).
  const blindHoleBox = (scope: DisposeScope): OccShape =>
    scope.track(boolBodies(scope, scope.track(makeBox(occ, scope, 10, 10, 10)), cylinderAt(scope, 5, 5, 7, 2, 3), 'cut'))

  // A 10-box with a boss r2 h3 on top.
  const bossBox = (scope: DisposeScope): OccShape =>
    scope.track(boolBodies(scope, scope.track(makeBox(occ, scope, 10, 10, 10)), cylinderAt(scope, 5, 5, 10, 2, 3), 'fuse'))

  // An L plate: 10x10x5 minus a 5x5x5 corner (non-convex top face).
  const lPlate = (scope: DisposeScope): OccShape =>
    scope.track(boolBodies(scope, scope.track(makeBox(occ, scope, 10, 10, 5)), scope.track(makeBoxAt(occ, scope, [5, 5, 0], 5, 5, 5)), 'cut'))

  // A right isoceles triangular prism: legs 10/10 in x/z, depth 10 in y.
  function wedge(scope: DisposeScope): OccShape {
    const e1 = scope.track(makeLineEdge(occ, scope, [0, 0, 0], [10, 0, 0]))
    const e2 = scope.track(makeLineEdge(occ, scope, [10, 0, 0], [0, 0, 10]))
    const e3 = scope.track(makeLineEdge(occ, scope, [0, 0, 10], [0, 0, 0]))
    const wire = scope.track(makeWire(occ, scope, [e1, e2, e3], { requireClosed: true }))
    const face = scope.track(makeFaceFromWire(occ, scope, wire))
    return scope.track(makePrism(occ, scope, face, [0, 1, 0], 10))
  }

  // A prism of a Bezier-capped D shape: the curved side is a spline neighbour.
  function splineNeighbour(scope: DisposeScope): OccShape {
    const arc = scope.track(makeBezierEdge(occ, scope, [[0, 0, 0], [5, -3, 0], [10, 0, 0]]))
    const line = scope.track(makeLineEdge(occ, scope, [10, 0, 0], [0, 0, 0]))
    const wire = scope.track(makeWire(occ, scope, [arc, line], { requireClosed: true }))
    const face = scope.track(makeFaceFromWire(occ, scope, wire))
    return scope.track(makePrism(occ, scope, face, [0, 0, 1], 5))
  }

  // ─── face pickers ───

  const pickMaxZ = (scope: DisposeScope, body: OccShape): OccShape => {
    let best = canonicalFaces(occ, scope, body)[0] as OccShape
    for (const f of canonicalFaces(occ, scope, body)) {
      if (faceCentroid(occ, scope, f as OccShape)[2] > faceCentroid(occ, scope, best)[2]) best = f as OccShape
    }
    return best
  }
  const pickMinZ = (scope: DisposeScope, body: OccShape): OccShape => {
    let best = canonicalFaces(occ, scope, body)[0] as OccShape
    for (const f of canonicalFaces(occ, scope, body)) {
      if (faceCentroid(occ, scope, f as OccShape)[2] < faceCentroid(occ, scope, best)[2]) best = f as OccShape
    }
    return best
  }
  function pickByNormal(scope: DisposeScope, body: OccShape, want: Vec3, atZ?: number): OccShape {
    for (const f of canonicalFaces(occ, scope, body)) {
      const n = faceNormal(occ, scope, f as OccShape)
      if (Math.abs(n[0] - want[0]) < 1e-9 && Math.abs(n[1] - want[1]) < 1e-9 && Math.abs(n[2] - want[2]) < 1e-9) {
        if (atZ === undefined || Math.abs(faceCentroid(occ, scope, f as OccShape)[2] - atZ) < 1e-6) return f as OccShape
      }
    }
    throw new Error('no face matched the normal/height')
  }

  const moved = (scope: DisposeScope, body: OccShape, face: OccShape, d: number): OccShape =>
    applyMoveFace(occ, scope, body, face, d).shape

  function expectVolume(scope: DisposeScope, shape: OccShape, expected: number): void {
    expect(valueWithinTolerance(volumeOf(occ, scope, shape), expected), `volume ${volumeOf(occ, scope, shape)} vs ${expected}`).toBe(true)
  }

  // ─── the results table ───

  it('box 10 top: +5 adds, -3 removes', () => {
    for (const [d, want] of [[5, 1500], [-3, 700]] as const) {
      const scope = new DisposeScope()
      try {
        const body = scope.track(makeBox(occ, scope, 10, 10, 10))
        expectVolume(scope, moved(scope, body, pickMaxZ(scope, body), d), want)
      } finally { scope.dispose() }
    }
  })

  it('cone r10 h20 base: +5 / -5 extend the cone (exact frustums)', () => {
    for (const [d, want] of [[5, coneV(12.5, 25)], [-5, coneV(7.5, 15)]] as const) {
      const scope = new DisposeScope()
      try {
        const body = scope.track(cone(scope, 10, 0, 20))
        expectVolume(scope, moved(scope, body, pickMinZ(scope, body), d), want)
      } finally { scope.dispose() }
    }
  })

  it('cone base moved -25 consumes the body (empty result)', () => {
    const scope = new DisposeScope()
    try {
      const body = scope.track(cone(scope, 10, 0, 20))
      const out = moved(scope, body, pickMinZ(scope, body), -25)
      expect(volumeOf(occ, scope, out)).toBeCloseTo(0, 6)
    } finally { scope.dispose() }
  })

  it('frustum r10->5 h10 top: +8 exact', () => {
    const scope = new DisposeScope()
    try {
      const body = scope.track(cone(scope, 10, 5, 10))
      expectVolume(scope, moved(scope, body, pickMaxZ(scope, body), 8), frustumV(10, 1, 18))
    } finally { scope.dispose() }
  })

  it('frustum top at and past the apex: full cone, top face gone (2 faces)', () => {
    for (const d of [10, 15]) {
      const scope = new DisposeScope()
      try {
        const body = scope.track(cone(scope, 10, 5, 10))
        const out = moved(scope, body, pickMaxZ(scope, body), d)
        expectVolume(scope, out, coneV(10, 20))
        expect(canonicalFaces(occ, scope, out)).toHaveLength(2)
      } finally { scope.dispose() }
    }
  })

  it('frustum bottom and top moved -4', () => {
    {
      const scope = new DisposeScope()
      try {
        const body = scope.track(cone(scope, 10, 5, 10))
        expectVolume(scope, moved(scope, body, pickMinZ(scope, body), -4), frustumV(8, 5, 6))
      } finally { scope.dispose() }
    }
    {
      const scope = new DisposeScope()
      try {
        const body = scope.track(cone(scope, 10, 5, 10))
        expectVolume(scope, moved(scope, body, pickMaxZ(scope, body), -4), frustumV(10, 7, 6))
      } finally { scope.dispose() }
    }
  })

  it('chamfered box top: chamfers extend, then vanish (6 faces), then grow', () => {
    for (const [d, want] of [[-1, 881.333], [-3, 700], [2, 965.333]] as const) {
      const scope = new DisposeScope()
      try {
        const body = chamferedBox(scope)
        const out = moved(scope, body, pickMaxZ(scope, body), d)
        expectVolume(scope, out, want)
        if (d === -3) expect(canonicalFaces(occ, scope, out)).toHaveLength(6)
      } finally { scope.dispose() }
    }
  })

  it('the selection regression: chamfer +2 is 965.333, never the sliver-cell 3369', () => {
    const scope = new DisposeScope()
    try {
      const body = chamferedBox(scope)
      const v = volumeOf(occ, scope, moved(scope, body, pickMaxZ(scope, body), 2))
      expect(v).toBeLessThan(1000)
      expect(valueWithinTolerance(v, 965.333)).toBe(true)
    } finally { scope.dispose() }
  })

  it('U channel floor: deepen / raise / pass the arms', () => {
    for (const [d, want] of [[-2, 2200], [3, 2700], [8, 3200]] as const) {
      const scope = new DisposeScope()
      try {
        const body = uChannel(scope)
        const floor = pickByNormal(scope, body, [0, 0, 1], 4)
        expectVolume(scope, moved(scope, body, floor, d), want)
      } finally { scope.dispose() }
    }
  })

  it('U left arm top moved -3 leaves the right arm', () => {
    const scope = new DisposeScope()
    try {
      const body = uChannel(scope)
      const armTop = canonicalFaces(occ, scope, body).find((f) => {
        const n = faceNormal(occ, scope, f as OccShape)
        const c = faceCentroid(occ, scope, f as OccShape)
        return Math.abs(n[2] - 1) < 1e-9 && Math.abs(c[2] - 10) < 1e-6 && c[0] < 6
      }) as OccShape
      expectVolume(scope, moved(scope, body, armTop, -3), 2100)
    } finally { scope.dispose() }
  })

  it('box with a blind hole: hole mouth moves with the top (floor passed, hole vanishes)', () => {
    for (const [d, want] of [[-2, 787.434], [-5, 500], [4, 1312.035]] as const) {
      const scope = new DisposeScope()
      try {
        const body = blindHoleBox(scope)
        expectVolume(scope, moved(scope, body, pickByNormal(scope, body, [0, 0, 1], 10), d), want)
      } finally { scope.dispose() }
    }
  })

  it('box with a boss: the boss root extends inward, the boss is swallowed outward', () => {
    for (const [d, want] of [[-2, 862.832], [5, 1500]] as const) {
      const scope = new DisposeScope()
      try {
        const body = bossBox(scope)
        expectVolume(scope, moved(scope, body, pickByNormal(scope, body, [0, 0, 1], 10), d), want)
      } finally { scope.dispose() }
    }
  })

  it('cylinder top +4 is exact', () => {
    const scope = new DisposeScope()
    try {
      const body = cylinderAt(scope, 0, 0, 0, 5, 10)
      expectVolume(scope, moved(scope, body, pickMaxZ(scope, body), 4), PI * 25 * 14)
    } finally { scope.dispose() }
  })

  it('L-shaped top (non-convex face): +3 / -2, 3 of 14 cells picked', () => {
    for (const [d, want] of [[3, 600], [-2, 225]] as const) {
      const scope = new DisposeScope()
      try {
        const body = lPlate(scope)
        const cells = moveFaceCells(occ, scope, body, pickMaxZ(scope, body), d)
        expect(cells.cells).toHaveLength(3)
        expectVolume(scope, moved(scope, body, pickMaxZ(scope, body), d), want)
      } finally { scope.dispose() }
    }
  })

  it('wedge, slanted 45 deg face +1', () => {
    const scope = new DisposeScope()
    try {
      const body = wedge(scope)
      const slant = pickByNormal(scope, body, [Math.SQRT1_2, 0, Math.SQRT1_2])
      expectVolume(scope, moved(scope, body, slant, 1), 651.421)
    } finally { scope.dispose() }
  })

  // ─── guards ───

  it('refuses a tangent neighbour (a filleted box top), not a 48748 slab', () => {
    const scope = new DisposeScope()
    try {
      const body = filletedBox(scope)
      let threw: unknown = null
      try { moved(scope, body, pickMaxZ(scope, body), 2) } catch (e) { threw = e }
      expect(threw).toBeInstanceOf(MoveFaceRefusal)
      expect((threw as Error).message).toContain('tangent')
    } finally { scope.dispose() }
  })

  it('refuses a non-planar picked face', () => {
    const scope = new DisposeScope()
    try {
      const body = cylinderAt(scope, 0, 0, 0, 5, 10)
      const lateral = canonicalFaces(occ, scope, body).find((f) => neighbourSurface(occ, scope, f as OccShape) === 'cylinder')
      let threw: unknown = null
      try { moved(scope, body, lateral as OccShape, 2) } catch (e) { threw = e }
      expect(threw).toBeInstanceOf(MoveFaceRefusal)
      expect((threw as Error).message).toContain('planar')
    } finally { scope.dispose() }
  })

  it('refuses an unsupported neighbour surface by name', () => {
    const scope = new DisposeScope()
    try {
      const body = splineNeighbour(scope)
      const cap = pickByNormal(scope, body, [0, 0, 1])
      let threw: unknown = null
      try { moved(scope, body, cap, 2) } catch (e) { threw = e }
      expect(threw).toBeInstanceOf(MoveFaceRefusal)
      expect((threw as Error).message).toContain('cannot be extended')
    } finally { scope.dispose() }
  })

  // ─── edge classification pin ───

  it('BRepOffset_Analyse pins a hole mouth Convex, a boss root Concave, a fillet Tangent', () => {
    {
      const scope = new DisposeScope()
      try {
        const body = blindHoleBox(scope)
        const kind = classifyFaceEdges(occ, scope, body)
        const kinds = canonicalEdges(occ, scope, body).map((e) => kind(e as OccShape))
        // The hole mouth circle is Convex; a plain box contributes only convex
        // corners, so the pin is that the body reads convex at all (the binding
        // maps the enum correctly, not the number).
        expect(kinds).toContain('convex')
      } finally { scope.dispose() }
    }
    {
      const scope = new DisposeScope()
      try {
        const body = bossBox(scope)
        const kind = classifyFaceEdges(occ, scope, body)
        const kinds = canonicalEdges(occ, scope, body).map((e) => kind(e as OccShape))
        // The boss root circle is Concave: a box alone never reports one.
        expect(kinds).toContain('concave')
      } finally { scope.dispose() }
    }
    {
      const scope = new DisposeScope()
      try {
        const body = filletedBox(scope)
        const kind = classifyFaceEdges(occ, scope, body)
        expect(canonicalEdges(occ, scope, body).some((e) => kind(e as OccShape) === 'tangent')).toBe(true)
      } finally { scope.dispose() }
    }
  })

  it('extendNeighbourFace refuses a spline surface by name', () => {
    const scope = new DisposeScope()
    try {
      const body = splineNeighbour(scope)
      const spline = canonicalFaces(occ, scope, body).find((f) => neighbourSurface(occ, scope, f as OccShape) === null)
      expect(spline).toBeDefined()
      let threw: unknown = null
      try { extendNeighbourFace(occ, scope, spline as OccShape, 50) } catch (e) { threw = e }
      expect(threw).toBeInstanceOf(MoveFaceRefusal)
      expect((threw as Error).message).toContain('cannot be extended')
    } finally { scope.dispose() }
  })
})
