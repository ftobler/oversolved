// @vitest-environment node
//
// Real-OCC guard for the face hover outline: a periodic face is tessellated in
// its UV domain, cut open at the seam, so the outline derived from the mesh must
// weld the seam's duplicate vertices. A raw index-pair count draws the seam,
// which the renderer otherwise hides (hidden_edges). Skips when the OCC build is
// absent, like every *Real suite.
import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import { HandleTable } from '../handleTable'
import { buildProfileExtrude } from '../shapes'
import { makeBox, makeCircleEdge, makeCone, makeCylinder, makeFaceFromWire, makeWire } from '../primitives'
import { booleanWithDiff } from '../booleans'
import { revolveFace } from '../prismLineage'
import { solidToEdges, solidToFaceEdgeQueries, solidToMesh, type TessMesh } from '../tessellation'
import { buildFaceBoundarySegments } from '@/utils/partGeometry'
import type { Mesh3D } from '@/types/cad'
import type { OccModule } from '../occTypes'
import type { OccHandle } from '../handleTable'

const oc = await loadOcc()

type Point = [number, number, number]

/** The tessellated mesh in the shape the outline builder consumes. */
function asMesh3D(mesh: TessMesh): Mesh3D {
  return {
    vertices: mesh.vertices,
    faces: mesh.faces,
    triangle_to_face: mesh.triangle_to_face,
    face_queries: mesh.face_queries,
  }
}

function segmentsOf(vertices: Float32Array): [Point, Point][] {
  const out: [Point, Point][] = []
  for (let i = 0; i < vertices.length; i += 6) {
    out.push([
      [vertices[i], vertices[i + 1], vertices[i + 2]],
      [vertices[i + 3], vertices[i + 4], vertices[i + 5]],
    ])
  }
  return out
}

function faceOfType(mesh: TessMesh, type: string): number {
  const index = mesh.face_data.findIndex(face => face.surface_type === type)
  expect(index, `no ${type} face`).toBeGreaterThanOrEqual(0)
  return index
}

describe.skipIf(!oc)('face outline seam weld (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  // The face's seam queries, which must be non-empty for the fixture to prove anything.
  function seamsOf(table: HandleTable, handle: OccHandle, face: number): string[] {
    const { edge_queries } = solidToEdges(occ, table, handle, { createdBy: 'seam1' })
    const { face_seam_queries } = solidToFaceEdgeQueries(occ, table, handle, edge_queries)
    expect(face_seam_queries[face].length, 'fixture must have a seam').toBeGreaterThan(0)
    return face_seam_queries[face]
  }

  it('draws a cylinder lateral face as its two rims, never down the seam', () => {
    const table = new HandleTable()
    // The production path: a full circle extruded along its axis.
    const handle = buildProfileExtrude(occ, table, {
      edges: [{ kind: 'circle', center: [0, 0, 0], normal: [0, 0, 1], xAxis: [1, 0, 0], radius: 5 }],
      direction: [0, 0, 1],
      distance: 10,
    })
    try {
      const mesh = solidToMesh(occ, table, handle)
      const face = faceOfType(mesh, 'cylinderface')
      seamsOf(table, handle, face)

      const segments = segmentsOf(buildFaceBoundarySegments(asMesh3D(mesh), face))
      expect(segments.length).toBeGreaterThan(0)
      for (const [a, b] of segments) {
        // Each rim segment stays on one of the extrude's end planes.
        for (const p of [a, b]) {
          expect(Math.min(Math.abs(p[2]), Math.abs(p[2] - 10))).toBeLessThan(1e-6)
        }
        expect(Math.abs(a[2] - b[2])).toBeLessThan(1e-6)
      }
      // Both rims contribute, and the same number of segments each.
      const bottom = segments.filter(([a]) => Math.abs(a[2]) < 1e-6)
      const top = segments.filter(([a]) => Math.abs(a[2] - 10) < 1e-6)
      expect(bottom.length).toBeGreaterThan(0)
      expect(top).toHaveLength(bottom.length)
    } finally {
      table.release(handle)
      table.assertNoLeaks()
    }
  })

  it('draws a cone lateral face as its base rim, never down the seam', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      // Apex at the origin, base radius 5 at z = 10: the same cone the seam
      // suite uses, so its seam is the axial line and the apex is degenerate.
      const handle = table.register(makeCone(occ, scope, [0, 0, 0], [0, 0, 1], 0, 5, 10))
      try {
        const mesh = solidToMesh(occ, table, handle)
        const face = faceOfType(mesh, 'coneface')
        seamsOf(table, handle, face)

        const segments = segmentsOf(buildFaceBoundarySegments(asMesh3D(mesh), face))
        expect(segments.length).toBeGreaterThan(0)
        for (const [a, b] of segments) {
          for (const p of [a, b]) expect(Math.abs(p[2] - 10)).toBeLessThan(1e-6)
          expect(Math.abs(a[2] - b[2])).toBeLessThan(1e-6)
        }
      } finally {
        table.release(handle)
      }
    } finally {
      scope.dispose()
      table.assertNoLeaks()
    }
  })

  it('leaves a full torus with no outline at all, because its seams are its only border', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      // A full revolve of an off-axis circle: the production torus path.
      const circle = makeCircleEdge(occ, scope, [8, 0, 0], [0, 1, 0], [1, 0, 0], 2)
      const wire = makeWire(occ, scope, [circle], { requireClosed: true })
      const profile = makeFaceFromWire(occ, scope, wire)
      const handle = table.register(scope.track(revolveFace(occ, scope, profile, [0, 0, 0], [0, 0, 1], 360)))
      try {
        const mesh = solidToMesh(occ, table, handle)
        const face = faceOfType(mesh, 'torusface')
        seamsOf(table, handle, face)

        // D2: a closed periodic face with no other border has no visible
        // outline. The face fill still marks the hover, so this is intended.
        expect(segmentsOf(buildFaceBoundarySegments(asMesh3D(mesh), face))).toHaveLength(0)
      } finally {
        table.release(handle)
      }
    } finally {
      scope.dispose()
      table.assertNoLeaks()
    }
  })

  it('keeps the outer rectangle and the hole circle apart on a plate with a hole', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const plate = makeBox(occ, scope, 10, 6, 4)
      const drill = makeCylinder(occ, scope, [5, 3, -1], [0, 0, 1], 1.2, 6)
      const handle = table.register(booleanWithDiff(occ, scope, plate, drill, 'cut').shape)
      try {
        const mesh = solidToMesh(occ, table, handle)
        // The top face is the one the hole opens on.
        const face = mesh.face_data.findIndex(f =>
          f.surface_type === 'flatface' && f.normal[2] > 0.99 && Math.abs(f.centroid[2] - 4) < 1e-6)
        expect(face).toBeGreaterThanOrEqual(0)

        const onOuter = (p: Point) =>
          Math.min(Math.abs(p[0]), Math.abs(p[0] - 10), Math.abs(p[1]), Math.abs(p[1] - 6)) < 1e-6
        const onHole = (p: Point) => Math.abs(Math.hypot(p[0] - 5, p[1] - 3) - 1.2) < 1e-6

        const segments = segmentsOf(buildFaceBoundarySegments(asMesh3D(mesh), face))
        for (const [a, b] of segments) {
          // A segment never crosses from the outer loop to the hole: the weld
          // merges coincident vertices, not two loops a hole radius apart.
          expect(onOuter(a) || onHole(a)).toBe(true)
          expect(onOuter(a)).toBe(onOuter(b))
          expect(onHole(a)).toBe(onHole(b))
        }
        // The rectangle's four sides plus the tessellated hole circle.
        expect(segments.filter(([a]) => onOuter(a))).toHaveLength(4)
        expect(segments.filter(([a]) => onHole(a)).length).toBeGreaterThan(0)
      } finally {
        table.release(handle)
      }
    } finally {
      scope.dispose()
      table.assertNoLeaks()
    }
  })
})
