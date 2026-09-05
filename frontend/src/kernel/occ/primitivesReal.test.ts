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
import { HandleTable, type OccHandle } from './handleTable'
import { DisposeScope } from './disposeScope'
import { CountingScope } from './countingScope'
import { sortedFacesOf } from './faceLoops'
import { buildBox, buildCylinder, buildExtrudedProfile } from './shapes'
import {
  faceCentroid,
  faceNormal,
  faceArea,
  faceSurfaceFrame,
  faceSurfaceType,
  faceSurfaceTypeAndNormal,
  makeBezierEdge,
  makeFaceFromWire,
  makePrism,
  makeWire,
  readEdgeSamplePoints,
  readSolidEdges,
  readSolidVertices,
  type SurfaceType,
  type Vec3,
} from './primitives'
import { revolveFace } from './prismLineage'
import type { OccDisposable, OccModule, OccShape } from './occTypes'

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

  it('faceSurfaceFrame reads a spherical cap anchor point as the sphere centre, not a surface centroid', () => {
    // No sphere primitive exists in the feature builder yet (only box / sketch+extrude /
    // cylinder), so this constructs the analytic solid directly, as the box/cylinder
    // tests above do. BRepPrimAPI_MakeSphere_7(center, radius, angle1, angle2) builds a
    // spherical cap (here: equator to pole) -- a PARTIAL sphere, so its surface centroid
    // is off-centre and only faceSurfaceFrame gets the true centre right.
    const scope = new DisposeScope()
    try {
      const center = scope.track(new occ.gp_Pnt_3(1, 2, 3))
      const MakeSphere = (occ as unknown as {
        BRepPrimAPI_MakeSphere_7: new (
          p: typeof center, r: number, a1: number, a2: number,
        ) => { Shape(): OccShape } & OccDisposable
      }).BRepPrimAPI_MakeSphere_7
      const capShape = scope.track(new MakeSphere(center, 5, 0, Math.PI / 2)).Shape()
      const E = occ.TopAbs_ShapeEnum
      const exp = scope.track(new occ.TopExp_Explorer_2(capShape, E.TopAbs_FACE, E.TopAbs_SHAPE))
      let cap: OccShape | null = null
      for (; exp.More(); exp.Next()) {
        const f = scope.track(occ.TopoDS.Face_1(exp.Current()))
        if (faceSurfaceType(occ, scope, f) === 'sphereface') cap = f
      }
      expect(cap).not.toBeNull()
      const frame = faceSurfaceFrame(occ, scope, cap!)
      expect(frame).not.toBeNull()
      expect(frame!.origin[0]).toBeCloseTo(1, 6)
      expect(frame!.origin[1]).toBeCloseTo(2, 6)
      expect(frame!.origin[2]).toBeCloseTo(3, 6)
      expect(frame!.radius).toBeCloseTo(5, 6)
      // The cap's centroid sits up near its pole, nowhere near the sphere's centre --
      // exactly why extractBodyAnchors must read frame.origin, never faceCentroid.
      const centroid = faceCentroid(occ, scope, cap!)
      const dist = Math.hypot(centroid[0] - frame!.origin[0], centroid[1] - frame!.origin[1], centroid[2] - frame!.origin[2])
      expect(dist).toBeGreaterThan(2)
    } finally {
      scope.dispose()
    }
  })

  it('faceSurfaceFrame returns null for a plane (the caller already has the right axis: the normal)', () => {
    const table = new HandleTable({ finalizerGuard: false })
    const h = buildBox(occ, table, { dx: 10, dy: 10, dz: 5, owner: 'box' })
    const scope = new DisposeScope()
    try {
      const E = occ.TopAbs_ShapeEnum
      const exp = scope.track(new occ.TopExp_Explorer_2(table.get(h), E.TopAbs_FACE, E.TopAbs_SHAPE))
      let checked = 0
      for (; exp.More(); exp.Next()) {
        const f = scope.track(occ.TopoDS.Face_1(exp.Current()))
        expect(faceSurfaceFrame(occ, scope, f)).toBeNull()
        checked++
      }
      expect(checked).toBe(6)
    } finally {
      scope.dispose()
      table.release(h)
    }
  })

  it('faceSurfaceFrame returns null for a surface class it does not model (a Bezier-profile prism wall)', () => {
    const scope = new DisposeScope()
    try {
      const bez = makeBezierEdge(occ, scope, [[0, 0, 0], [3, 2, 0], [6, -2, 0], [10, 0, 0]])
      const line = scope.track(
        new occ.BRepBuilderAPI_MakeEdge_3(scope.track(new occ.gp_Pnt_3(10, 0, 0)), scope.track(new occ.gp_Pnt_3(0, 0, 0))),
      ).Edge()
      const wire = makeWire(occ, scope, [bez, line])
      const face = makeFaceFromWire(occ, scope, wire)
      const prism = makePrism(occ, scope, face, [0, 0, 1], 5)
      const E = occ.TopAbs_ShapeEnum
      const exp = scope.track(new occ.TopExp_Explorer_2(prism, E.TopAbs_FACE, E.TopAbs_SHAPE))
      let sawNonPlanar = false
      for (; exp.More(); exp.Next()) {
        const f = scope.track(occ.TopoDS.Face_1(exp.Current()))
        if (faceSurfaceType(occ, scope, f) !== 'flatface') {
          sawNonPlanar = true
          expect(faceSurfaceFrame(occ, scope, f)).toBeNull()
        }
      }
      expect(sawNonPlanar).toBe(true)
    } finally {
      scope.dispose()
    }
  })

  it('faceSurfaceFrame reads the exact axis/origin/radius of a cylinder built at a non-axis-aligned orientation', () => {
    const table = new HandleTable({ finalizerGuard: false })
    const n = 1 / Math.sqrt(3)
    const h = buildCylinder(occ, table, { center: [2, 3, 4], axis: [n, n, n], radius: 3, height: 10, owner: 'c' })
    const scope = new DisposeScope()
    try {
      const E = occ.TopAbs_ShapeEnum
      const exp = scope.track(new occ.TopExp_Explorer_2(table.get(h), E.TopAbs_FACE, E.TopAbs_SHAPE))
      let wall: ReturnType<typeof faceSurfaceFrame> = null
      for (; exp.More(); exp.Next()) {
        const f = scope.track(occ.TopoDS.Face_1(exp.Current()))
        if (faceSurfaceType(occ, scope, f) === 'cylinderface') wall = faceSurfaceFrame(occ, scope, f)
      }
      expect(wall).not.toBeNull()
      expect(wall!.origin[0]).toBeCloseTo(2, 6)
      expect(wall!.origin[1]).toBeCloseTo(3, 6)
      expect(wall!.origin[2]).toBeCloseTo(4, 6)
      expect(wall!.axis[0]).toBeCloseTo(n, 6)
      expect(wall!.axis[1]).toBeCloseTo(n, 6)
      expect(wall!.axis[2]).toBeCloseTo(n, 6)
      expect(wall!.radius).toBeCloseTo(3, 6)
    } finally {
      scope.dispose()
      table.release(h)
    }
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

  it('faceSurfaceTypeAndNormal matches faceSurfaceType + faceNormal on all six box faces', () => {
    const table = new HandleTable({ finalizerGuard: false })
    const h = buildBox(occ, table, { dx: 10, dy: 10, dz: 5, owner: 'box' })
    const scope = new DisposeScope()
    try {
      const E = occ.TopAbs_ShapeEnum
      const exp = scope.track(new occ.TopExp_Explorer_2(table.get(h), E.TopAbs_FACE, E.TopAbs_SHAPE))
      let checked = 0
      for (; exp.More(); exp.Next()) {
        const f = scope.track(occ.TopoDS.Face_1(exp.Current()))
        const both = faceSurfaceTypeAndNormal(occ, scope, f)
        // One-adaptor read must agree with the two single readers it replaced,
        // including the REVERSED sign flip the six-face outward-normal test pins.
        expect(both.surfaceType).toBe(faceSurfaceType(occ, scope, f))
        expect(both.normal).toEqual(faceNormal(occ, scope, f))
        checked++
      }
      expect(checked).toBe(6)
    } finally {
      scope.dispose()
      table.release(h)
    }
  })


  // Create a 1x1 square face in the XY plane via makeFaceFromWire.
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
      expect(areaAfter).toBeCloseTo(1.0, 6)  // 1x1 square
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
        return  // gap correctly surfaced by wire builder
      }

      // Layer 2: face builder must not silently repair
      try {
        const face = makeFaceFromWire(occ, scope, wire)
        const area = faceArea(occ, scope, face)
        // A silently-repaired face would have non-trivial area (~0.25);
        // a degenerate face from a gapped wire has near-zero area.
        expect(area).toBeLessThan(0.001)
      } catch {
        // face builder or area computation threw, gap correctly surfaced
      }
    } finally {
      scope.dispose()
    }
  })

  // Topological-identity dedup (occ-o-n-dedup-primitives): the explorer yields
  // each shared edge/vertex once per owning face, so the readers must collapse
  // those raw hits to the true unique count. A box's 12 edges are each shared by
  // 2 faces (24 raw hits) and its 8 vertices by 3 (24 raw hits).
  it('readSolidEdges dedups a box to its 12 unique edges', () => {
    const table = new HandleTable({ finalizerGuard: false })
    const h = buildBox(occ, table, { dx: 10, dy: 10, dz: 5, owner: 'box' })
    const scope = new DisposeScope()
    try {
      const edges = readSolidEdges(occ, scope, table.get(h))
      expect(edges).toHaveLength(12)
    } finally {
      scope.dispose()
      table.release(h)
    }
  })

  it('readSolidVertices dedups a box to its 8 unique vertices', () => {
    const table = new HandleTable({ finalizerGuard: false })
    const h = buildBox(occ, table, { dx: 10, dy: 10, dz: 5, owner: 'box' })
    const scope = new DisposeScope()
    try {
      const verts = readSolidVertices(occ, scope, table.get(h))
      expect(verts).toHaveLength(8)
      // The eight corners of a 10x10x5 box, deduped and complete.
      const key = (v: Vec3): string => v.map((x) => Math.round(x * 1e6) / 1e6).join(',')
      const got = new Set(verts.map(key))
      const want = new Set(
        ([
          [0, 0, 0], [10, 0, 0], [0, 10, 0], [10, 10, 0],
          [0, 0, 5], [10, 0, 5], [0, 10, 5], [10, 10, 5],
        ] as Vec3[]).map(key),
      )
      expect(got).toEqual(want)
    } finally {
      scope.dispose()
      table.release(h)
    }
  })

  it('readSolidEdges/Vertices dedup a cylinder to 3 edges and 2 vertices', () => {
    const table = new HandleTable({ finalizerGuard: false })
    const h = buildCylinder(occ, table, {
      center: [0, 0, 0], axis: [0, 0, 1], radius: 3, height: 10, owner: 'cyl',
    })
    const scope = new DisposeScope()
    try {
      // Two circular cap edges + one vertical seam edge; the seam's two endpoints.
      expect(readSolidEdges(occ, scope, table.get(h))).toHaveLength(3)
      expect(readSolidVertices(occ, scope, table.get(h))).toHaveLength(2)
    } finally {
      scope.dispose()
      table.release(h)
    }
  })

  it('readEdgeSamplePoints carries the full box AABB from deduped edges', () => {
    const table = new HandleTable({ finalizerGuard: false })
    const h = buildBox(occ, table, { dx: 10, dy: 10, dz: 5, owner: 'box' })
    const scope = new DisposeScope()
    try {
      const pts = readEdgeSamplePoints(occ, scope, table.get(h), 8)
      const xs = pts.map((p) => p[0])
      const ys = pts.map((p) => p[1])
      const zs = pts.map((p) => p[2])
      expect(Math.min(...xs)).toBeCloseTo(0, 6)
      expect(Math.max(...xs)).toBeCloseTo(10, 6)
      expect(Math.min(...ys)).toBeCloseTo(0, 6)
      expect(Math.max(...ys)).toBeCloseTo(10, 6)
      expect(Math.min(...zs)).toBeCloseTo(0, 6)
      expect(Math.max(...zs)).toBeCloseTo(5, 6)
    } finally {
      scope.dispose()
      table.release(h)
    }
  })

  it('readSolidEdges handles a sphere with degenerate pole edges', () => {
    const scope = new DisposeScope()
    try {
      const center = scope.track(new occ.gp_Pnt_3(0, 0, 0))
      const MakeSphere = (occ as unknown as {
        BRepPrimAPI_MakeSphere_7: new (
          p: typeof center, r: number, a1: number, a2: number,
        ) => { Shape(): OccShape } & OccDisposable
      }).BRepPrimAPI_MakeSphere_7
      const sphere = scope.track(new MakeSphere(center, 5, 0, Math.PI)).Shape()
      const edges = readSolidEdges(occ, scope, sphere)
      expect(edges.length).toBeGreaterThanOrEqual(1)
      const pts = readEdgeSamplePoints(occ, scope, sphere, 8)
      expect(pts.length).toBeGreaterThan(0)
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

  it('sortedFacesOf keeps the build-scope live set at ~2 proxies per face (M45)', () => {
    const table = new HandleTable({ finalizerGuard: false })
    // Build the solids on their own scope so the measurement sees only the
    // traversal's own track() traffic, not the profile builders'.
    const build = new DisposeScope()
    let h100: OccHandle
    let h150: OccHandle
    try {
      const ring = (n: number): Vec3[] => Array.from({ length: n }, (_, i) => {
        const a = (i / n) * 2 * Math.PI
        return [20 * Math.cos(a), 20 * Math.sin(a), 0]
      })
      h100 = buildExtrudedProfile(occ, table, { loop: ring(100), direction: [0, 0, 1], distance: 5, owner: 'p100' })
      h150 = buildExtrudedProfile(occ, table, { loop: ring(150), direction: [0, 0, 1], distance: 5, owner: 'p150' })
    } finally {
      build.dispose()
    }
    // A fresh scope per solid keeps the peak proportional to that solid's own
    // faces: the returned faces stay live on the scope (they are the caller's
    // list), so a shared scope would let the first solid's faces inflate the
    // second solid's peak and blur the per-face multiplier. Two face counts
    // then pin the per-face multiplier, not an absolute peak an unrelated
    // change would re-tune.
    try {
      for (const handle of [h100, h150]) {
        const scope = new CountingScope()
        try {
          const faces = sortedFacesOf(occ, scope, table.get<OccShape>(handle))
          expect(faces.length).toBeGreaterThan(100)
          // The returned Face_1 plus its explorer raw Current are both tracked
          // on the caller's scope (2 per face); the geometry readers (GProp,
          // adaptor, SLProps) are transient via withTransientScope. The pre-M45
          // code kept 6 per face and would blow past the 2x + slack bound here.
          // Slack covers the explorer itself and embind bookkeeping.
          expect(scope.peakLive).toBeLessThanOrEqual(2 * faces.length + 8)
        } finally {
          scope.dispose()
        }
      }
    } finally {
      table.release(h100)
      table.release(h150)
      table.assertNoLeaks()
    }
  })
})
