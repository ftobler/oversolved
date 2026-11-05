// @vitest-environment node
//
// Dual-run mesh parity: build the same solids the Python kernel built (box,
// cylinder, extruded square; the frozen meshFixtures.json snapshot), tessellate
// with the OCC.js port, and assert the meshes match within
// tessellation tolerance. Skips when opencascade.js is absent (npm run occ:install).

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../loadOcc'
import { HandleTable } from '../handleTable'
import { DisposeScope } from '../disposeScope'
import { buildBox, buildCylinder, buildExtrudedProfile, buildProfileExtrude, type EdgeSpec } from '../shapes'
import { solidToMesh, solidToEdges, solidToFaceEdgeQueries, solidToVertices, type TessMesh, type FaceDatum } from '../tessellation'
import { booleanWithDiff } from '../booleans'
import { makeBox, makeBoxAt, makeCone } from '../primitives'
import { isSeamEdge } from '@/kernel/select/geometry'
import type { BodyResult } from '@/types/cad'
import { parseAncestry } from '../../query'
import type { OccModule } from '../occTypes'
import type { OccHandle } from '../handleTable'
import type { Vec3 } from '../primitives'
import type { EdgeData } from '@/types/cad'
import fixtures from '../__fixtures__/meshFixtures.json'

const oc = await loadOcc()

interface FixtureFaceDatum {
  centroid: number[]
  normal: number[]
  area: number
  surface_type: string
}
interface FixtureMesh {
  vertices: number[][]
  faces: number[][]
  triangle_to_face: number[]
  face_data: FixtureFaceDatum[]
}
interface Fixture {
  kind: string
  params: Record<string, unknown>
  mesh: FixtureMesh
  edges: EdgeData[]
  vertices: number[][]
}

const allFixtures = fixtures as unknown as Record<string, Fixture>

function buildFixture(occ: OccModule, table: HandleTable, fx: Fixture): OccHandle {
  const p = fx.params
  if (fx.kind === 'box') {
    return buildBox(occ, table, { dx: p.dx as number, dy: p.dy as number, dz: p.dz as number })
  }
  if (fx.kind === 'cylinder') {
    return buildCylinder(occ, table, {
      center: p.center as Vec3,
      axis: p.axis as Vec3,
      radius: p.radius as number,
      height: p.height as number,
    })
  }
  if (fx.kind === 'extrude') {
    return buildExtrudedProfile(occ, table, {
      loop: p.loop as Vec3[],
      direction: p.direction as Vec3,
      distance: p.distance as number,
    })
  }
  if (fx.kind === 'profile') {
    return buildProfileExtrude(occ, table, {
      edges: p.edges as EdgeSpec[],
      direction: p.direction as Vec3,
      distance: p.distance as number,
    })
  }
  throw new Error(`unknown fixture kind ${fx.kind}`)
}

function sortedVertices(verts: Vec3[] | number[][]): number[][] {
  return [...verts]
    .map((v) => [v[0], v[1], v[2]])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
}

function totalArea(faceData: FaceDatum[] | FixtureFaceDatum[]): number {
  return faceData.reduce((s, f) => s + f.area, 0)
}

describe.skipIf(!oc)('tessellation dual-run parity (OCC.js vs Python)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable')
    occ = oc
  })

  interface TsGeom {
    mesh: TessMesh
    edges: EdgeData[]
    vertices: Vec3[]
  }

  function run(name: string): { ts: TsGeom; fx: Fixture } {
    const fx = allFixtures[name]
    const table = new HandleTable()
    const h = buildFixture(occ, table, fx)
    const mesh = solidToMesh(occ, table, h)
    const edges = solidToEdges(occ, table, h).edges
    const vertices = solidToVertices(occ, table, h).vertices
    table.release(h)
    table.assertNoLeaks()
    return { ts: { mesh, edges, vertices }, fx }
  }

  // ─── edge / vertex geometry parity ───

  const sortPts = (pts: number[][]): number[][] =>
    [...pts].map((v) => [v[0], v[1], v[2]]).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])

  function lineEndpoints(edges: EdgeData[]): number[][] {
    const out: number[][] = []
    for (const e of edges) if (e.kind === 'line') out.push([...e.start], [...e.end])
    return sortPts(out)
  }

  function curveKeys(edges: EdgeData[]): number[][] {
    const out: number[][] = []
    for (const e of edges) {
      if (e.kind === 'circle' || e.kind === 'arc') {
        out.push([e.center[0], e.center[1], e.center[2], e.radius])
      }
    }
    return sortPts(out)
  }

  function kindHistogram(edges: EdgeData[]): Record<string, number> {
    const h: Record<string, number> = {}
    for (const e of edges) h[e.kind] = (h[e.kind] ?? 0) + 1
    return h
  }

  function assertPointSets(a: number[][], b: number[][], digits: number) {
    expect(a).toHaveLength(b.length)
    for (let i = 0; i < b.length; i++) {
      for (let k = 0; k < b[i].length; k++) expect(a[i][k]).toBeCloseTo(b[i][k], digits)
    }
  }

  function assertEdgeVertexParity(ts: TsGeom, fx: Fixture) {
    // Edge count + kind histogram (deterministic sort means counts are exact).
    expect(ts.edges).toHaveLength(fx.edges.length)
    expect(kindHistogram(ts.edges)).toEqual(kindHistogram(fx.edges))
    // Line endpoints and curve (center,radius) sets match as multisets.
    assertPointSets(lineEndpoints(ts.edges), lineEndpoints(fx.edges), 4)
    assertPointSets(curveKeys(ts.edges), curveKeys(fx.edges), 4)
    // Vertices: same set (Python does not sort, so compare unordered).
    assertPointSets(sortPts(ts.vertices), sortPts(fx.vertices), 5)
  }

  function assertFaceDataParity(ts: TessMesh, py: FixtureMesh, exactArea: boolean) {
    expect(ts.face_data).toHaveLength(py.face_data.length)
    // Both kernels sort faces by the same (flat-before-curved, normal, centroid)
    // key, so face_data is aligned index-for-index.
    for (let i = 0; i < py.face_data.length; i++) {
      const a = ts.face_data[i]
      const b = py.face_data[i]
      expect(a.surface_type).toBe(b.surface_type)
      // Centroid is the GProp area-centroid (exact geometry, not tessellation).
      for (let k = 0; k < 3; k++) expect(a.centroid[k]).toBeCloseTo(b.centroid[k], 5)
      if (a.surface_type === 'flatface') {
        // A planar face has a single well-defined normal in both kernels.
        for (let k = 0; k < 3; k++) expect(a.normal[k]).toBeCloseTo(b.normal[k], 5)
      }
      // A curved face has no single normal: Python samples via a point
      // projection, we via SLProps at the UV midpoint, so the sampled angle (and
      // thus the normal) legitimately differs -- not asserted.
      if (exactArea) {
        expect(a.area).toBeCloseTo(b.area, 4)
      } else {
        // Areas are tessellation sums over a curved boundary; compare in band.
        expect(a.area).toBeGreaterThan(0)
        expect(Math.abs(a.area - b.area) / b.area).toBeLessThan(0.02)
      }
    }
    // triangle_to_face is a valid mapping into face_data.
    expect(ts.triangle_to_face).toHaveLength(ts.faces.length)
    expect(Math.max(...ts.triangle_to_face)).toBeLessThan(ts.face_data.length)
  }

  // Straight-boundary bodies: tessellation is corner-only and deterministic, so
  // these match Python node-for-node.
  for (const planar of ['box_10x10x5', 'extruded_square_10x10x5']) {
    it(`matches Python exactly for ${planar} (planar, deterministic)`, () => {
      const { ts, fx } = run(planar)
      const py = fx.mesh
      expect(ts.mesh.vertices).toHaveLength(py.vertices.length)
      expect(ts.mesh.faces).toHaveLength(py.faces.length)
      // Node order within a face can differ, so compare the vertex multiset.
      const tsv = sortedVertices(ts.mesh.vertices)
      const pyv = sortedVertices(py.vertices)
      for (let i = 0; i < pyv.length; i++) {
        for (let k = 0; k < 3; k++) expect(tsv[i][k]).toBeCloseTo(pyv[i][k], 6)
      }
      expect(ts.mesh.triangle_to_face).toEqual(py.triangle_to_face)
      assertFaceDataParity(ts.mesh, py, true)
      assertEdgeVertexParity(ts, fx)
    })
  }

  // Curved-boundary bodies (primitive cylinder, circle-extrude, line+arc wedge):
  // tessellation node count depends on deflection, so gate on topology, areas,
  // and a triangle-count band rather than node-for-node equality.
  for (const curved of ['cylinder_r3_h10', 'circle_extrude_r3_h10', 'pie_wedge_r10_q1_h5']) {
    it(`matches Python for ${curved} within tessellation tolerance`, () => {
      const { ts, fx } = run(curved)
      const py = fx.mesh
      assertFaceDataParity(ts.mesh, py, false)
      const tsArea = totalArea(ts.mesh.face_data)
      const pyArea = totalArea(py.face_data)
      expect(Math.abs(tsArea - pyArea) / pyArea).toBeLessThan(0.01)
      const tsTris = ts.mesh.faces.length
      const pyTris = py.faces.length
      expect(Math.abs(tsTris - pyTris) / pyTris).toBeLessThan(0.05)
      assertEdgeVertexParity(ts, fx)
    })
  }

  it('emits face_queries and classifiers for a box (2d wiring)', () => {
    const fx = allFixtures['box_10x10x5']
    const table = new HandleTable()
    const h = buildFixture(occ, table, fx)
    const mesh = solidToMesh(occ, table, h, {
      createdBy: 'ex1',
      bodyId: 'body_ex1',
      profileQueries: ['@sk1/line1'],
    })
    table.release(h)
    table.assertNoLeaks()
    expect(mesh.face_queries.length).toBe(6)
    expect(mesh.face_data.length).toBe(6)
    for (const q of mesh.face_queries) {
      expect(q).toContain('ex1')
      expect(q).toContain('body_ex1')
    }
    // A 10x10x5 box has one face per side; every planar face gets a classifier.
    const allClassifiers = mesh.face_data.flatMap((fd) => fd.classifiers ?? [])
    expect(allClassifiers.length).toBe(6)
    expect(new Set(allClassifiers).size).toBe(6)  // each face has a unique side
  })

  // An edge whose ancestry token list is an EMPTY array (a prism side edge is
  // attributed from its adjacent faces, so a cap-only edge carries `[]`) must be
  // treated as having no ancestry: the emitted edge query falls back to the
  // profile tokens, matching the builder's registered key. Same truthiness trap
  // as classifyFace: `[]` used to null the profile fallback.
  it('treats an empty edgeAncestry list as absent and falls back to the profile tokens', () => {
    const table = new HandleTable()
    const h = buildBox(occ, table, { dx: 10, dy: 10, dz: 5 })
    try {
      // One uuid per canonical edge; the first call reports which one the
      // first displayed edge carries, and that one gets the empty list.
      const edgeUuids = Array.from({ length: 12 }, (_, i) => `u_${i}`)
      const base = solidToEdges(occ, table, h, { createdBy: 'ex1', bodyId: 'body_ex1', edgeUuids })
      const edgeAncestry: Record<string, string[]> = {}
      base.edge_uuids.forEach((uuid, idx) => {
        edgeAncestry[uuid!] = idx === 0 ? [] : ['@sk1/bottom']
      })
      const out = solidToEdges(occ, table, h, {
        createdBy: 'ex1',
        bodyId: 'body_ex1',
        edgeUuids,
        edgeAncestry,
        profileQueries: ['@sk1/bottom', '@sk1/top'],
      })
      const [emptyIds] = parseAncestry(out.edge_queries[0])
      expect(emptyIds, 'empty edge ancestry list must fall back to the profile tokens').toEqual(
        expect.arrayContaining(['@ex1', '@body_ex1', '@sk1/bottom', '@sk1/top']),
      )
      const [tokenIds] = parseAncestry(out.edge_queries[1])
      expect(tokenIds, 'real edge ancestry tokens must win over the profile tokens').toEqual(
        expect.arrayContaining(['@ex1', '@body_ex1', '@sk1/bottom']),
      )
      expect(tokenIds).not.toEqual(expect.arrayContaining(['@sk1/top']))
    } finally {
      table.release(h)
      table.assertNoLeaks()
    }
  })

  // A vertex with no named-face neighbour earns no construction UUID; its query
  // then falls back to the ancestral net and must still carry the profile
  // tokens (the net shared with its siblings). Pins the vertex fallback.
  it('vertex no-neighbour fallback: a uuid-less vertex query still carries the profile tokens', () => {
    const table = new HandleTable()
    const h = buildBox(occ, table, { dx: 10, dy: 10, dz: 5 })
    try {
      const out = solidToVertices(occ, table, h, {
        createdBy: 'ex1',
        bodyId: 'body_ex1',
        profileQueries: ['@sk1/bottom', '@sk1/top'],
      })
      expect(out.vertex_queries.length).toBe(8)
      for (const q of out.vertex_queries) {
        const [ids] = parseAncestry(q)
        expect(ids.some((i) => i.startsWith('@u|')), 'no faceNames -> no vertex earns a UUID').toBe(false)
        expect(ids, 'the no-neighbour vertex must carry the profile tokens').toEqual(
          expect.arrayContaining(['@ex1', '@body_ex1', '@sk1/bottom', '@sk1/top']),
        )
      }
    } finally {
      table.release(h)
      table.assertNoLeaks()
    }
  })

  // The entity<->query ARRAY CONTRACT. Both producers return every entity but
  // could only build queries under `createdBy`, so a body without one yielded N
  // entities and 0 queries -- and every caller passes `body.created_by || ''`.
  // Consumers zip the two by index, so the short array silently handed them
  // `undefined` in a field typed `string` (partBundle's toBodyMesh) or ran off
  // the end (extractBodyAnchors). solidToMesh has always padded face_queries
  // with ''; these two now do the same, which is what makes the consumer guards
  // belt-and-braces instead of load-bearing.
  it('emits one query per entity even with no createdBy (positional zip contract)', () => {
    const table = new HandleTable()
    const h = buildBox(occ, table, { dx: 10, dy: 10, dz: 5 })
    try {
      // Exactly what the callers pass for a body with a falsy `created_by`.
      const e = solidToEdges(occ, table, h, { createdBy: '', bodyId: 'body_ex1' })
      expect(e.edges.length).toBe(12)
      expect(e.edge_queries.length, 'edge_queries must line up with edges').toBe(e.edges.length)
      expect(e.edge_queries.every((q) => q === '')).toBe(true)

      const v = solidToVertices(occ, table, h, { createdBy: '', bodyId: 'body_ex1' })
      expect(v.vertices.length).toBe(8)
      expect(v.vertex_queries.length, 'vertex_queries must line up with vertices').toBe(v.vertices.length)
      expect(v.vertex_queries.every((q) => q === '')).toBe(true)

      // And with no opts at all (the default-`{}` call sites).
      const bare = solidToEdges(occ, table, h)
      expect(bare.edge_queries.length).toBe(bare.edges.length)
      const bareV = solidToVertices(occ, table, h)
      expect(bareV.vertex_queries.length).toBe(bareV.vertices.length)
    } finally {
      table.release(h)
      table.assertNoLeaks()
    }
  })
})

// ─── edge convexity published with the solve ───

describe.skipIf(!oc)('solidToEdges convexity (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  /** A plate with one rectangular through slot, cut from a solid so the mouth
   *  rims and the four slot corners are real B-rep edges. */
  function slottedPlate(table: HandleTable): OccHandle {
    const scope = new DisposeScope()
    try {
      const plate = makeBox(occ, scope, 40, 30, 5)
      const slot = makeBoxAt(occ, scope, [10, 10, -1], 20, 10, 7)
      const { shape } = booleanWithDiff(occ, scope, plate, slot, 'cut')
      // The result belongs to the caller's table, so it must outlive the scope.
      // A clean result is untracked by contract; a fallback result is tracked.
      if (scope.isTracked(shape)) scope.detach(shape)
      return table.register(shape, 'slot')
    } finally {
      scope.dispose()
    }
  }

  it('classifies a slotted plate: slot corners concave, outer edges convex', () => {
    const table = new HandleTable()
    const h = slottedPlate(table)
    try {
      const out = solidToEdges(occ, table, h, { computeConvexity: true })
      expect(out.edges.length).toBe(24)
      // The twelve outer edges of the plate (four top, four bottom, four
      // vertical corners) are convex ridges.
      const outer = out.edges.filter((e) =>
        e.kind === 'line' && (e.start[0] === 0 || e.start[0] === 40 || e.start[1] === 0 || e.start[1] === 30))
      expect(outer).toHaveLength(12)
      for (const edge of outer) expect(edge.convexity, JSON.stringify(edge)).toBe('convex')

      // The four vertical slot corners are inside corners.
      const slotCorners = out.edges.filter((e) =>
        e.kind === 'line' && e.start[2] === 0 && e.end[2] === 5
        && e.start[0] > 0 && e.start[0] < 40 && e.start[1] > 0 && e.start[1] < 30)
      expect(slotCorners).toHaveLength(4)
      for (const edge of slotCorners) expect(edge.convexity, JSON.stringify(edge)).toBe('concave')
    } finally {
      table.release(h)
      table.assertNoLeaks()
    }
  })

  it('pins the slot mouth rim class the analyser actually reports', () => {
    const table = new HandleTable()
    const h = slottedPlate(table)
    try {
      const out = solidToEdges(occ, table, h, { computeConvexity: true })
      const rim = out.edges.filter((e) =>
        e.kind === 'line' && e.start[2] === e.end[2] && (e.start[2] === 0 || e.start[2] === 5)
        && e.start[0] >= 10 && e.start[0] <= 30 && e.start[1] >= 10 && e.start[1] <= 20)
      expect(rim).toHaveLength(8)
      // A slot mouth where the top face meets the wall: the class the analyser
      // reports, pinned. docs/drive.md's mouth-rim sentence derives from this.
      const classes = new Set(rim.map((e) => e.convexity))
      expect(classes).toEqual(new Set(['convex']))
    } finally {
      table.release(h)
      table.assertNoLeaks()
    }
  })

  it('reports a tangent chain along a stadium profile joint', () => {
    const table = new HandleTable()
    const h = buildProfileExtrude(occ, table, {
      edges: [
        { kind: 'line', start: [-10, -4, 0], end: [10, -4, 0] },
        { kind: 'arc', center: [10, 0, 0], normal: [0, 0, 1], xAxis: [1, 0, 0], radius: 4, angleStart: -Math.PI / 2, angleEnd: Math.PI / 2 },
        { kind: 'line', start: [10, 4, 0], end: [-10, 4, 0] },
        { kind: 'arc', center: [-10, 0, 0], normal: [0, 0, 1], xAxis: [1, 0, 0], radius: 4, angleStart: Math.PI / 2, angleEnd: 3 * Math.PI / 2 },
      ],
      direction: [0, 0, 1],
      distance: 5,
    })
    try {
      const out = solidToEdges(occ, table, h, { computeConvexity: true })
      // The two end arcs meet the straight walls tangentially, so the four
      // vertical joints along the extrusion are the tangent chain.
      const verticals = out.edges.filter((e) =>
        e.kind === 'line' && Math.abs(e.end[2] - e.start[2]) > 1e-9)
      expect(verticals).toHaveLength(4)
      for (const edge of verticals) expect(edge.convexity, JSON.stringify(edge)).toBe('tangent')
    } finally {
      table.release(h)
      table.assertNoLeaks()
    }
  })

  it('reports a full cylinder seam as other and isSeamEdge agrees', () => {
    const table = new HandleTable()
    const h = buildCylinder(occ, table, { center: [0, 0, 0], axis: [0, 0, 1], radius: 5, height: 10 })
    try {
      const out = solidToEdges(occ, table, h, { computeConvexity: true, createdBy: 'ex1', bodyId: 'body_c' })
      const faceData = solidToFaceEdgeQueries(occ, table, h, out.edge_queries)
      const seams = new Set(faceData.face_seam_queries.flat())
      expect(seams.size, 'one lateral seam').toBe(1)
      const seamQuery = [...seams][0]
      const index = out.edge_queries.indexOf(seamQuery)
      expect(index).toBeGreaterThanOrEqual(0)
      // A seam has the same face on both sides, so BRepOffset_Analyse has no
      // dihedral angle to report and leaves it `other`. This is the measured
      // kernel convention: a seam is NOT tangent, and the `seam` leaf is the
      // only direct way to name it.
      expect(out.edges[index].convexity).toBe('other')

      const body: BodyResult = {
        id: 'body_c',
        created_by: 'ex1',
        modified_by: [],
        edges: out.edges,
        edge_queries: out.edge_queries,
        mesh: {
          vertices: [],
          faces: [],
          face_data: [],
          face_queries: [],
          face_edge_queries: faceData.face_edge_queries,
          face_seam_queries: faceData.face_seam_queries,
        },
      }
      expect(isSeamEdge({ body, bodyId: 'body_c', kind: 'edge', index, query: seamQuery })).toBe(true)
      const otherIndex = out.edge_queries.findIndex((q) => q !== seamQuery)
      expect(isSeamEdge({ body, bodyId: 'body_c', kind: 'edge', index: otherIndex, query: out.edge_queries[otherIndex] })).toBe(false)
    } finally {
      table.release(h)
      table.assertNoLeaks()
    }
  })

  it('leaves the field absent when the pass is not opted in', () => {
    const table = new HandleTable()
    const h = buildBox(occ, table, { dx: 10, dy: 10, dz: 5 })
    try {
      const out = solidToEdges(occ, table, h)
      expect(out.edges.every((e) => e.convexity === undefined)).toBe(true)
    } finally {
      table.release(h)
      table.assertNoLeaks()
    }
  })

  it('reports a cone seam as other, the same convention as the cylinder', () => {
    // The docs and the type comment say "measured on a cylinder and a cone";
    // pin both, so a change in how OCC classifies a self-joining face is caught
    // rather than only described.
    const table = new HandleTable()
    const scope = new DisposeScope()
    const cone = scope.track(makeCone(occ, scope, [0, 0, 0], [0, 0, 1], 5, 2, 10))
    const h = table.register(scope.detach(cone), 'cone')
    try {
      const out = solidToEdges(occ, table, h, { computeConvexity: true, createdBy: 'ex1', bodyId: 'body_cone' })
      const faceData = solidToFaceEdgeQueries(occ, table, h, out.edge_queries)
      const seams = new Set(faceData.face_seam_queries.flat())
      expect(seams.size, 'one lateral seam').toBe(1)
      const index = out.edge_queries.indexOf([...seams][0])
      expect(index).toBeGreaterThanOrEqual(0)
      expect(out.edges[index].convexity).toBe('other')
    } finally {
      table.release(h)
      scope.dispose()
      table.assertNoLeaks()
    }
  })
})
