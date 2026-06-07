// @vitest-environment node
//
// Phase 2b exit criterion: dual-run mesh parity. Build the same solids Python
// built (box, cylinder, extruded square; meshFixtures.json from
// tests/wasm_harness/gen_mesh_fixture.py), tessellate with the OCC.js port, and
// assert the meshes match within tessellation tolerance. Skips when
// opencascade.js is absent (npm run occ:install).

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from './loadOcc'
import { HandleTable } from './handleTable'
import { buildBox, buildCylinder, buildExtrudedProfile, buildProfileExtrude, type EdgeSpec } from './shapes'
import { solidToMesh, solidToEdges, solidToVertices, type TessMesh, type FaceDatum } from './tessellation'
import type { OccModule } from './occTypes'
import type { OccHandle } from './handleTable'
import type { Vec3 } from './primitives'
import type { EdgeData } from '@/types/cad'
import fixtures from './__fixtures__/meshFixtures.json'

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
    const table = new HandleTable({ finalizerGuard: false })
    const h = buildFixture(occ, table, fx)
    const mesh = solidToMesh(occ, table, h)
    const edges = solidToEdges(occ, table, h).edges
    const vertices = solidToVertices(occ, table, h).vertices
    table.release(h)
    table.assertNoLeaks()
    return { ts: { mesh, edges, vertices }, fx }
  }

  // --- edge / vertex geometry parity ---------------------------------------

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
    const table = new HandleTable({ finalizerGuard: false })
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
    expect(new Set(allClassifiers).size).toBe(6) // each face has a unique side
  })
})
