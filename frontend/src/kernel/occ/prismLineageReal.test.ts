// @vitest-environment node
//
// Gated real-OCC parity gate for prismLineage.ts (the extrude leaf's brep
// producer): extrudeProfileWithLineage. Feeds the same profile loops as the
// frozen golden extrude fixture through the TS port and asserts the
// produced solid volume + the profile-entity token attribution match Python.
//
// The geom-hash face_lineage/edge_lineage output was removed; the same
// profile-entity tokens now survive on the construction-name ancestry maps
// (uuid -> tokens). We build with a createdBy so those maps populate, then
// compare token attribution key-independently (the sorted multiset of non-empty
// token-lists). faceAncestry matches the golden face_lineage exactly; edgeAncestry
// is a SUBSET (a cylinder seam edge, whose adjacent faces share one UUID, gets no
// edge UUID, so its token is dropped).
//
// Skips when opencascade.js is absent. The fixture is a frozen golden snapshot.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from './loadOcc'
import { DisposeScope } from './disposeScope'
import { volumeOf } from './booleans'
import { extrudeProfileWithLineage, canonicalizeFaceCirclesWith, buildPrismLineageMap, sketchLoopsToFace } from './prismLineage'
import { makeArcEdge, makeLineEdge, makeWire, makeFaceFromWire, healWire, faceNormal, faceSurfaceType, type Vec3 } from './primitives'
import type { PlaneLike } from '../features/shared/planes'
import type { LoopEdge } from '../profileLoops'
import type { OccModule, OccShape, OccListOfShape } from './occTypes'
import fixture from './__fixtures__/extrude.json'

const oc = await loadOcc()

type Lineage = Record<string, string[]>
type Case = {
  name: string
  loops: LoopEdge[][]
  plane: PlaneLike
  direction: number[]
  distance: number
  sketch_id: string
  volume: number
  face_lineage: Lineage
  edge_lineage: Lineage
}
const fx = fixture as unknown as { cases: Case[] }

/**
 * Sorted multiset of the NON-EMPTY sorted token-lists (key-independent view).
 * The geom-hash face_lineage/edge_lineage producer was removed; the
 * same profile-entity tokens now survive on the construction-name ancestry maps
 * (uuid -> tokens), so we compare token attribution key-independently. Empty
 * lists are dropped: caps carry no token, and ancestry only holds entries for
 * entities that were minted a UUID (a cylinder seam edge gets none).
 */
function tokenMultiset(d: Lineage): string[] {
  return Object.values(d)
    .filter((v) => v.length > 0)
    .map((v) => JSON.stringify([...v].sort()))
    .sort()
}

describe.skipIf(!oc)('extrudeProfileWithLineage (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  for (const c of fx.cases) {
    it(`${c.name}: solid volume + face/edge token attribution match Python`, () => {
      const scope = new DisposeScope()
      try {
        const { solid, faceAncestry, edgeAncestry } = extrudeProfileWithLineage(
          occ,
          scope,
          c.loops,
          c.plane,
          c.direction as Vec3,
          c.distance,
          c.sketch_id,
          'feat',
        )
        expect(volumeOf(occ, scope, solid)).toBeCloseTo(c.volume, 3)
        // Distinct token-lists: the name layer keys faces by UUID, so a profile
        // entity generating more than one face dedupes to a single entry.
        expect(new Set(tokenMultiset(faceAncestry))).toEqual(new Set(tokenMultiset(c.face_lineage)))
        // Edge token attribution is a SUBSET of the old edge_lineage: edgeAncestry
        // drops the cylinder seam edge (same-face pair -> no UUID). deriveEdgeNames
        // tests pin the edge naming directly.
        const goldenEdges = new Set(tokenMultiset(c.edge_lineage))
        for (const t of tokenMultiset(edgeAncestry)) expect(goldenEdges.has(t)).toBe(true)
      } finally {
        scope.dispose()
      }
    })
  }
})

/**
 * The pre-prism profile union's reseam helper.  Drives it with a planar face
 * whose single hole wire is a 2-arc chain on the same circle (the shape a
 * hole-boundary split between two source regions has after the fuse+clean
 * round-trip).  Asserts the helper produces a face whose hole wire is ONE
 * closed-circle edge on that circle's own frame -- the canonical seam that
 * makes both the body's hole cylinder and a later tool's hole cylinder agree.
 */
describe.skipIf(!oc)('canonicalizeFaceCirclesWith (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  it('collapses a 2-arc-same-circle hole wire to one closed-circle edge with identical face geometry', () => {
    const scope = new DisposeScope()
    try {
      // A 10x10 planar square outer wire, centered on the origin, on the XY plane.
      const a: Vec3 = [-5, -5, 0]
      const b: Vec3 = [5, -5, 0]
      const c: Vec3 = [5, 5, 0]
      const d: Vec3 = [-5, 5, 0]
      const outerWire = makeWire(occ, scope, [
        makeLineEdge(occ, scope, a, b),
        makeLineEdge(occ, scope, b, c),
        makeLineEdge(occ, scope, c, d),
        makeLineEdge(occ, scope, d, a),
      ])
      // The hole: a circle centered at the origin, radius 2, split into TWO
      // arcs at the meridian angle (0 / pi) -- exactly the case where the
      // fuse of two source regions parked the merged seam off-canonical.
      const holeCenter: Vec3 = [0, 0, 0]
      const holeNormal: Vec3 = [0, 0, 1]
      const holeXAxis: Vec3 = [1, 0, 0]
      const holeRadius = 2.0
      const halfArc1 = makeArcEdge(occ, scope, holeCenter, holeNormal, holeXAxis, holeRadius, 0, Math.PI)
      const halfArc2 = makeArcEdge(occ, scope, holeCenter, holeNormal, holeXAxis, holeRadius, Math.PI, 2 * Math.PI)
      const holeWire = makeWire(occ, scope, [halfArc1, halfArc2])
      const original = makeFaceFromWire(occ, scope, outerWire, [holeWire])

      const rebuiltNullable = canonicalizeFaceCirclesWith(occ, scope, outerWire, [holeWire])
      expect(rebuiltNullable).not.toBeNull()
      const rebuilt = rebuiltNullable as OccShape

      // Sanity: rebuilt face is planar, normal up.
      expect(faceSurfaceType(occ, scope, rebuilt)).toBe('flatface')
      const n = faceNormal(occ, scope, rebuilt)
      expect(Math.abs(n[2] - 1)).toBeLessThan(1e-6)

      // The hole wire of the rebuilt face must be exactly ONE closed-circle
      // edge whose supporting circle has the same center+radius as the input
      // (so geom-hash identity -- centroid+normal for the face, center+radius
      // for the edge -- is preserved).
      const e = occ.TopAbs_ShapeEnum
      const oWire = scope.track(occ.BRepTools.OuterWire(rebuilt))
      const wexp = scope.track(new occ.TopExp_Explorer_2(rebuilt, e.TopAbs_WIRE, e.TopAbs_SHAPE))
      let holeEdgeCount = 0
      let outerEdgeCount = 0
      for (; wexp.More(); wexp.Next()) {
        const w = scope.track(occ.TopoDS.Wire_1(wexp.Current()))
        const isOuter = (w as unknown as { IsSame(o: OccShape): boolean }).IsSame(oWire)
        const eexp = scope.track(new occ.TopExp_Explorer_2(w, e.TopAbs_EDGE, e.TopAbs_SHAPE))
        let n2 = 0
        for (; eexp.More(); eexp.Next()) n2++
        if (isOuter) outerEdgeCount = n2
        else holeEdgeCount = n2
      }
      expect(outerEdgeCount).toBe(4)  // outer wire untouched: still 4 line edges
      expect(holeEdgeCount).toBe(1)   // hole collapsed to a single closed-circle edge

      // Same area as the original (planar geometry preserved): square area 100
      // minus the circle disk area pi r^2 = 4 pi ~ 12.57 -> ~87.43.
      const props = scope.track(new occ.GProp_GProps_1())
      occ.BRepGProp.SurfaceProperties_1(rebuilt, props, false, false)
      expect(props.Mass()).toBeCloseTo(100 - 4 * Math.PI, 5)
      const propsOrig = scope.track(new occ.GProp_GProps_1())
      occ.BRepGProp.SurfaceProperties_1(original, propsOrig, false, false)
      expect(props.Mass()).toBeCloseTo(propsOrig.Mass(), 6)
    } finally {
      scope.dispose()
    }
  })

  it('leaves a face whose hole is a single non-co-circular chain untouched (returns null)', () => {
    /** A mixed 2-arc hole on two distinct circles must NOT be collapsed -- the
     *  helper returns null and the caller keeps the original face verbatim. */
    const scope = new DisposeScope()
    try {
      const a: Vec3 = [-10, -10, 0]
      const b: Vec3 = [10, -10, 0]
      const c: Vec3 = [10, 10, 0]
      const d: Vec3 = [-10, 10, 0]
      const outerWire = makeWire(occ, scope, [
        makeLineEdge(occ, scope, a, b),
        makeLineEdge(occ, scope, b, c),
        makeLineEdge(occ, scope, c, d),
        makeLineEdge(occ, scope, d, a),
      ])
      // Two arcs of DIFFERENT circles (centered at (-3,0) vs (-3,0) but
      // different radii) joined at (and only at) one shared point is not a
      // real hole; use TWO separate circles entirely: a small circle (r=1)
      // and a larger one (r=2), sharing one tangent point. The collapse must
      // reject them (not co-circular).
      const c1: Vec3 = [-3, 0, 0]
      const c2: Vec3 = [3, 0, 0]
      const nrm: Vec3 = [0, 0, 1]
      const xAxis: Vec3 = [1, 0, 0]
      // half-arc (center, r=1) from ang 0 to pi  (forms a semi around (-3,0))
      const h1 = makeArcEdge(occ, scope, c1, nrm, xAxis, 1.0, 0, Math.PI)
      // cut that short by forging 3 arcs on circle-2 around (3,0) r=2 which
      // have DIFFERENT center+radius -> helper must bail (radius mismatch).
      const h2 = makeArcEdge(occ, scope, c2, nrm, xAxis, 2.0, Math.PI, 2 * Math.PI)
      // These two arcs do not share endpoints (h1 ends at (-3,1), h2 starts
      // at (3,0)), so the wire would not even close; that's fine for the
      // unit test -- the closure is incidental: collapseCircleWire walks
      // edges and rejects because center mismatches, BEFORE any wire
      // chaining check exists.  Feed each as a separate hole wire to keep
      // the surface intact.
      const result = canonicalizeFaceCirclesWith(
        occ, scope, outerWire,
        [makeWire(occ, scope, [h1]), makeWire(occ, scope, [h2])],
      )
      expect(result).toBeNull()  // neither hole is co-circular -> no change -> null
    } finally {
      scope.dispose()
    }
  })
})

/**
 * The multi-group extrude path (perGroupPrismWithLineage) fuses one prism per
 * profile group; each fuse replaces the running `solid` with its output, so the
 * prior running solid must be released or it strands one dead solid per
 * group-boundary. This builds two DISJOINT rectangles (which force the legacy
 * per-group fuse path rather than the single-connected pre-prism union) and
 * asserts the fused body is one valid solid whose volume is the sum of the two
 * prisms -- a regression guard for the running-solid release fix.
 */
describe.skipIf(!oc)('extrudeProfileWithLineage multi-group (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  const plane: PlaneLike = {
    origin: [0, 0, 0],
    x_axis: [1, 0, 0],
    y_axis: [0, 1, 0],
    normal: [0, 0, 1],
  }

  const rect = (prefix: string, x0: number, y0: number, w: number, h: number): LoopEdge[] => [
    { id: `${prefix}e1`, kind: 'line', start: [x0, y0], end: [x0 + w, y0] },
    { id: `${prefix}e2`, kind: 'line', start: [x0 + w, y0], end: [x0 + w, y0 + h] },
    { id: `${prefix}e3`, kind: 'line', start: [x0 + w, y0 + h], end: [x0, y0 + h] },
    { id: `${prefix}e4`, kind: 'line', start: [x0, y0 + h], end: [x0, y0] },
  ]

  it('fuses two disjoint groups into one solid of summed prism volume', () => {
    const scope = new DisposeScope()
    try {
      const loops: LoopEdge[][] = [rect('a', 0, 0, 2, 2), rect('b', 10, 0, 2, 2)]
      const { solid } = extrudeProfileWithLineage(occ, scope, loops, plane, [0, 0, 1], 5, 'sk', 'feat')
      // Two 2x2 prisms of height 5 -> 2 * (4 * 5) = 40.
      expect(volumeOf(occ, scope, solid)).toBeCloseTo(40, 3)
    } finally {
      scope.dispose()
    }
  })
})

/**
 * The sweep's M11 lineage fix (plan_wave7 Change 2): the sweep heals the
 * profile's outer wire before sweeping it, and ShapeFix_Wire may REBUILD an
 * edge (a reorder/trim, not a merge). The builder then knows only the healed
 * wire's edges, so asking Generated() about the face's pre-heal edge answers
 * empty and every side face goes unnamed. The fix hands the healed wire to
 * buildPrismLineageMap as sweptProfile. This drives the builder directly with
 * a wire whose edges are REBUILT copies of the face's (same geometry, fresh
 * TShapes) and asserts the loud guard fires without the sweptProfile argument
 * and does not fire with it.
 */
describe.skipIf(!oc)('sweptProfile lineage off a rebuilt wire (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  it('refuses a pre-heal face when the builder swept a rebuilt wire, and names every side face off that wire', () => {
    const scope = new DisposeScope()
    try {
      const planeXY: PlaneLike = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }
      const square: LoopEdge[][] = [[
        { kind: 'line', start: [-2, -2], end: [2, -2], id: 'b' },
        { kind: 'line', start: [2, -2], end: [2, 2], id: 'r' },
        { kind: 'line', start: [2, 2], end: [-2, 2], id: 't' },
        { kind: 'line', start: [-2, 2], end: [-2, -2], id: 'l' },
      ]]
      const face = sketchLoopsToFace(occ, scope, square, planeXY)
      // Rebuilt copies of the face's outer-wire edges: identical geometry,
      // fresh TShapes -- the shape a ShapeFix_Wire edge rebuild leaves behind.
      const faceWire = scope.track(occ.BRepTools.OuterWire(face))
      const rebuiltEdges: OccShape[] = []
      const eexp = scope.track(new occ.TopExp_Explorer_2(faceWire, occ.TopAbs_ShapeEnum.TopAbs_EDGE, occ.TopAbs_ShapeEnum.TopAbs_SHAPE))
      for (; eexp.More(); eexp.Next()) {
        const raw = scope.track(eexp.Current())
        const edge = scope.track(occ.TopoDS.Edge_1(raw))
        const ad = scope.track(new occ.BRepAdaptor_Curve_2(edge))
        const sp = ad.Value(ad.FirstParameter())
        const ep = ad.Value(ad.LastParameter())
        const s: Vec3 = [sp.X(), sp.Y(), sp.Z()]
        const t: Vec3 = [ep.X(), ep.Y(), ep.Z()]
        sp.delete()
        ep.delete()
        rebuiltEdges.push(makeLineEdge(occ, scope, s, t))
      }
      const rebuiltWire = makeWire(occ, scope, rebuiltEdges)

      const spineEdges = [makeLineEdge(occ, scope, [0, 0, 0], [0, 0, 3])]
      const spineWire = healWire(occ, scope, makeWire(occ, scope, spineEdges))
      const builder = scope.track(new occ.BRepOffsetAPI_MakePipeShell(spineWire))
      builder.SetTransitionMode(occ.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RightCorner)
      builder.Add_1(rebuiltWire, false, false)
      builder.Build()
      if (!builder.IsDone() || !builder.MakeSolid()) throw new Error('probe pipe shell failed')
      const stub = {
        Shape: (): OccShape => builder.Shape(),
        Generated: (s: OccShape): OccListOfShape => builder.Generated(s),
      }

      // Without sweptProfile the builder is asked about the face's pre-heal
      // edges, which never went through the shell: the loud guard fires.
      expect(() => buildPrismLineageMap(occ, scope, face, stub, square, planeXY, 'feat', 'sk1')).toThrow(
        /generated no face for any profile edge/,
      )

      // With sweptProfile the explorer walks the rebuilt wire, Generated()
      // answers, and all four lateral faces plus both caps get named.
      const maps = buildPrismLineageMap(occ, scope, face, stub, square, planeXY, 'feat', 'sk1', 0, rebuiltWire)
      expect(Object.keys(maps.faceNames).length).toBe(6)
      expect(Object.values(maps.faceAncestry).filter((tokens) => tokens.length > 0).length).toBe(4)
    } finally {
      scope.dispose()
    }
  })
})
