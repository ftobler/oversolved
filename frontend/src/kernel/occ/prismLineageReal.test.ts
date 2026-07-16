// @vitest-environment node
//
// Gated real-OCC parity gate for prismLineage.ts (the extrude leaf's brep
// producer): extrudeProfileWithLineage. Feeds the same profile loops as the
// now-removed gen_extrude_fixture.py through the TS port and asserts the
// produced solid volume + the profile-entity token attribution match Python.
//
// Stage 7 removed the geom-hash face_lineage/edge_lineage output; the same
// profile-entity tokens now survive on the construction-name ancestry maps
// (uuid -> tokens). We build with a createdBy so those maps populate, then
// compare token attribution key-independently (the sorted multiset of non-empty
// token-lists). faceAncestry matches the golden face_lineage exactly; edgeAncestry
// is a SUBSET (a cylinder seam edge, whose adjacent faces share one UUID, gets no
// edge UUID, so its token is dropped).
//
// Skips when opencascade.js is absent. The fixture is a frozen golden snapshot;
// its generator (gen_extrude_fixture.py) was deleted with the Python kernel in
// phase 4d.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from './loadOcc'
import { DisposeScope } from './disposeScope'
import { volumeOf } from './booleans'
import { extrudeProfileWithLineage, canonicalizeFaceCirclesWith } from './prismLineage'
import { makeArcEdge, makeLineEdge, makeWire, makeFaceFromWire, faceNormal, faceSurfaceType, type Vec3 } from './primitives'
import type { PlaneLike } from '../features/shared'
import type { LoopEdge } from '../profileLoops'
import type { OccModule, OccShape } from './occTypes'
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
 * The geom-hash face_lineage/edge_lineage producer was removed in Stage 7; the
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
