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
import { buildBox, buildCylinder, buildExtrudedProfile } from './shapes'
import { solidToMesh, type TessMesh, type FaceDatum } from './tessellation'
import type { OccModule } from './occTypes'
import type { OccHandle } from './handleTable'
import type { Vec3 } from './primitives'
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

  function run(name: string): { ts: TessMesh; py: FixtureMesh } {
    const fx = allFixtures[name]
    const table = new HandleTable({ finalizerGuard: false })
    const h = buildFixture(occ, table, fx)
    const ts = solidToMesh(occ, table, h)
    table.release(h)
    table.assertNoLeaks()
    return { ts, py: fx.mesh }
  }

  function assertFaceDataParity(ts: TessMesh, py: FixtureMesh) {
    expect(ts.face_data).toHaveLength(py.face_data.length)
    // Both kernels sort faces by the same (flat-before-curved, normal, centroid)
    // key, so face_data is aligned index-for-index.
    for (let i = 0; i < py.face_data.length; i++) {
      const a = ts.face_data[i]
      const b = py.face_data[i]
      expect(a.surface_type).toBe(b.surface_type)
      for (let k = 0; k < 3; k++) expect(a.centroid[k]).toBeCloseTo(b.centroid[k], 5)
      if (a.surface_type === 'flatface') {
        // Planar faces have a single well-defined normal and an exact area.
        for (let k = 0; k < 3; k++) expect(a.normal[k]).toBeCloseTo(b.normal[k], 5)
        expect(a.area).toBeCloseTo(b.area, 4)
      } else {
        // A curved face has no single normal: Python samples it via a point
        // projection, we via SLProps at the UV midpoint, so the sampled angle
        // (and thus the normal) legitimately differs. Area is a tessellation
        // sum, so compare it within tolerance, not exactly.
        expect(a.area).toBeGreaterThan(0)
        expect(Math.abs(a.area - b.area) / b.area).toBeLessThan(0.02)
      }
    }
    // triangle_to_face is a valid mapping into face_data.
    expect(ts.triangle_to_face).toHaveLength(ts.faces.length)
    expect(Math.max(...ts.triangle_to_face)).toBeLessThan(ts.face_data.length)
  }

  for (const planar of ['box_10x10x5', 'extruded_square_10x10x5']) {
    it(`matches Python exactly for ${planar} (planar, deterministic)`, () => {
      const { ts, py } = run(planar)
      expect(ts.vertices).toHaveLength(py.vertices.length)
      expect(ts.faces).toHaveLength(py.faces.length)
      // Node order within a face can differ, so compare the vertex multiset.
      const tsv = sortedVertices(ts.vertices)
      const pyv = sortedVertices(py.vertices)
      for (let i = 0; i < pyv.length; i++) {
        for (let k = 0; k < 3; k++) expect(tsv[i][k]).toBeCloseTo(pyv[i][k], 6)
      }
      expect(ts.triangle_to_face).toEqual(py.triangle_to_face)
      assertFaceDataParity(ts, py)
    })
  }

  it('matches Python for the cylinder within tessellation tolerance', () => {
    const { ts, py } = run('cylinder_r3_h10')
    // Curved-wall triangle count can differ slightly between OCC builds; gate on
    // topology (face count + surface types), areas, and a tight count band.
    assertFaceDataParity(ts, py)
    const tsArea = totalArea(ts.face_data)
    const pyArea = totalArea(py.face_data)
    expect(Math.abs(tsArea - pyArea) / pyArea).toBeLessThan(0.01)
    const tsTris = ts.faces.length
    const pyTris = py.faces.length
    expect(Math.abs(tsTris - pyTris) / pyTris).toBeLessThan(0.05)
  })
})
