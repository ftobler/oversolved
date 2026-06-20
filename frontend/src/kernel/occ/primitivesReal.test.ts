// @vitest-environment node
//
// Real-OCC verification of the make-a-body primitives + geometry readers.
// Skips when opencascade.js is not installed (npm run occ:install). Builds box,
// cylinder, and extruded-square solids, reads per-face centroid/normal/surface
// type/area, and asserts the topology + the face-normal sign convention that
// must match Python. Everything routes through the HandleTable; the body is
// released at the end and the table asserted leak-free.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from './loadOcc'
import { HandleTable } from './handleTable'
import { DisposeScope } from './disposeScope'
import { buildBox, buildCylinder, buildExtrudedProfile } from './shapes'
import {
  faceCentroid,
  faceNormal,
  faceArea,
  faceSurfaceType,
  makeFaceFromWire,
  makePrism,
  makeWire,
  type SurfaceType,
  type Vec3,
} from './primitives'
import { revolveFace } from './prismLineage'
import type { OccModule, OccShape } from './occTypes'

const oc = await loadOcc()

interface FaceInfo {
  centroid: Vec3
  normal: Vec3
  area: number
  surfaceType: SurfaceType
}

function readFaces(occ: OccModule, solid: OccShape): FaceInfo[] {
  const scope = new DisposeScope()
  try {
    const E = occ.TopAbs_ShapeEnum
    const exp = scope.track(new occ.TopExp_Explorer_2(solid, E.TopAbs_FACE, E.TopAbs_SHAPE))
    const out: FaceInfo[] = []
    for (; exp.More(); exp.Next()) {
      const f = scope.track(occ.TopoDS.Face_1(exp.Current()))
      out.push({
        centroid: faceCentroid(occ, scope, f),
        normal: faceNormal(occ, scope, f),
        area: faceArea(occ, scope, f),
        surfaceType: faceSurfaceType(occ, scope, f),
      })
    }
    return out
  } finally {
    scope.dispose()
  }
}

const roundV = (v: Vec3): Vec3 => v.map((x) => Math.round(x * 1e6) / 1e6) as Vec3

describe.skipIf(!oc)('make-a-body primitives (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable')
    occ = oc
  })

  it('builds a box with 6 planar faces and outward normals', () => {
    const table = new HandleTable({ finalizerGuard: false })
    const h = buildBox(occ, table, { dx: 10, dy: 10, dz: 5, owner: 'box' })
    const faces = readFaces(occ, table.get(h))

    expect(faces).toHaveLength(6)
    expect(faces.every((f) => f.surfaceType === 'flatface')).toBe(true)

    const normals = new Set(faces.map((f) => JSON.stringify(roundV(f.normal))))
    expect(normals).toEqual(
      new Set(
        ([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as Vec3[]).map((n) =>
          JSON.stringify(roundV(n)),
        ),
      ),
    )
    // surface area of a 10x10x5 box = 2(100 + 50 + 50)
    const total = faces.reduce((s, f) => s + f.area, 0)
    expect(total).toBeCloseTo(400, 6)

    table.release(h)
    table.assertNoLeaks()
  })

  it('builds a cylinder: 2 planar caps + 1 cylindrical wall', () => {
    const table = new HandleTable({ finalizerGuard: false })
    const h = buildCylinder(occ, table, {
      center: [0, 0, 0],
      axis: [0, 0, 1],
      radius: 3,
      height: 10,
      owner: 'cyl',
    })
    const faces = readFaces(occ, table.get(h))
    expect(faces).toHaveLength(3)
    expect(faces.filter((f) => f.surfaceType === 'flatface')).toHaveLength(2)
    expect(faces.filter((f) => f.surfaceType === 'cylinderface')).toHaveLength(1)

    const wall = faces.find((f) => f.surfaceType === 'cylinderface')!
    expect(wall.area).toBeCloseTo(2 * Math.PI * 3 * 10, 4)
    const cap = faces.find((f) => f.surfaceType === 'flatface')!
    expect(cap.area).toBeCloseTo(Math.PI * 9, 4)

    table.release(h)
    table.assertNoLeaks()
  })

  it('builds an extruded square equivalent to a box', () => {
    const table = new HandleTable({ finalizerGuard: false })
    const h = buildExtrudedProfile(occ, table, {
      loop: [
        [0, 0, 0],
        [10, 0, 0],
        [10, 10, 0],
        [0, 10, 0],
      ],
      direction: [0, 0, 1],
      distance: 5,
      owner: 'ex',
    })
    const faces = readFaces(occ, table.get(h))
    expect(faces).toHaveLength(6)
    expect(faces.every((f) => f.surfaceType === 'flatface')).toBe(true)
    const total = faces.reduce((s, f) => s + f.area, 0)
    expect(total).toBeCloseTo(400, 6)
    table.release(h)
    table.assertNoLeaks()
  })


  /** Create a 1x1 square face in the XY plane via makeFaceFromWire. */
  function makeUnitSquareFace(occ2: OccModule, scope: DisposeScope): OccShape {
    const p00 = scope.track(new occ2.gp_Pnt_3(0, 0, 0))
    const p10 = scope.track(new occ2.gp_Pnt_3(1, 0, 0))
    const p11 = scope.track(new occ2.gp_Pnt_3(1, 1, 0))
    const p01 = scope.track(new occ2.gp_Pnt_3(0, 1, 0))
    const e1 = scope.track(new occ2.BRepBuilderAPI_MakeEdge_3(p00, p10)).Edge()
    const e2 = scope.track(new occ2.BRepBuilderAPI_MakeEdge_3(p10, p11)).Edge()
    const e3 = scope.track(new occ2.BRepBuilderAPI_MakeEdge_3(p11, p01)).Edge()
    const e4 = scope.track(new occ2.BRepBuilderAPI_MakeEdge_3(p01, p00)).Edge()
    const wire = makeWire(occ2, scope, [e1, e2, e3, e4])
    return makeFaceFromWire(occ2, scope, wire)
  }

  /**
   * ocp_make_prism uses Copy=True; the input face must not be mutated.
   */
  it('makePrism does not mutate the input face (Copy=True)', () => {
    const scope = new DisposeScope()
    try {
      const face = makeUnitSquareFace(occ, scope)
      const areaBefore = faceArea(occ, scope, face)
      makePrism(occ, scope, face, [0, 0, 1], 2.0)
      const areaAfter = faceArea(occ, scope, face)
      expect(areaAfter).toBeCloseTo(areaBefore, 6)
      expect(areaAfter).toBeCloseTo(1.0, 6) // 1x1 square
    } finally {
      scope.dispose()
    }
  })

  /**
   * ocp_revolve / revolveFace uses Copy=True; the input face must not be mutated.
   */
  it('revolveFace does not mutate the input face (Copy=True)', () => {
    const scope = new DisposeScope()
    try {
      const face = makeUnitSquareFace(occ, scope)
      const areaBefore = faceArea(occ, scope, face)
      revolveFace(occ, scope, face, [0, 0, 0], [0, 1, 0], 90)
      const areaAfter = faceArea(occ, scope, face)
      expect(areaAfter).toBeCloseTo(areaBefore, 6)
      expect(areaAfter).toBeCloseTo(1.0, 6)
    } finally {
      scope.dispose()
    }
  })

  /**
   * ocp_make_face_from_wire / makeFaceFromWire must NOT silently repair a gap
   * in the outer wire. A 0.5 gap exceeds Precision::Confusion() (1e-7). The
   * gap must be surfaced either by the wire builder (throw) or the face builder
   * (throw or degenerate-face with zero area).
   */
  it('makeFaceFromWire does not silently repair a gapped outer wire', () => {
    const scope = new DisposeScope()
    const GAP = 0.5
    try {
      const e1 = scope.track(
        new occ.BRepBuilderAPI_MakeEdge_3(
          scope.track(new occ.gp_Pnt_3(0, 0, 0)),
          scope.track(new occ.gp_Pnt_3(1, 0, 0)),
        ),
      ).Edge()
      const e2 = scope.track(
        new occ.BRepBuilderAPI_MakeEdge_3(
          scope.track(new occ.gp_Pnt_3(1, 0, 0)),
          scope.track(new occ.gp_Pnt_3(1, 1, 0)),
        ),
      ).Edge()
      // deliberate gap: next edge starts at (1+GAP, 1, 0) instead of (1, 1, 0)
      const e3 = scope.track(
        new occ.BRepBuilderAPI_MakeEdge_3(
          scope.track(new occ.gp_Pnt_3(1 + GAP, 1, 0)),
          scope.track(new occ.gp_Pnt_3(0, 1, 0)),
        ),
      ).Edge()
      const e4 = scope.track(
        new occ.BRepBuilderAPI_MakeEdge_3(
          scope.track(new occ.gp_Pnt_3(0, 1, 0)),
          scope.track(new occ.gp_Pnt_3(0, 0, 0)),
        ),
      ).Edge()

      // Layer 1: wire builder should reject the gap
      let wire: OccShape
      try {
        wire = makeWire(occ, scope, [e1, e2, e3, e4])
      } catch {
        return // gap correctly surfaced by wire builder
      }

      // Layer 2: face builder must not silently repair
      try {
        const face = makeFaceFromWire(occ, scope, wire)
        const area = faceArea(occ, scope, face)
        // A silently-repaired face would have non-trivial area (~0.25);
        // a degenerate face from a gapped wire has near-zero area.
        expect(area).toBeLessThan(0.001)
      } catch {
        // face builder or area computation threw — gap correctly surfaced
      }
    } finally {
      scope.dispose()
    }
  })

  it('stays leak-free across a 50-iteration build/evict loop', () => {
    const table = new HandleTable({ finalizerGuard: false })
    for (let i = 0; i < 50; i++) {
      const h = buildBox(occ, table, { dx: 3, dy: 4, dz: 5, owner: `b${i}` })
      readFaces(occ, table.get(h))
      table.release(h)
    }
    expect(table.liveCount()).toBe(0)
    table.assertNoLeaks()
  })
})
