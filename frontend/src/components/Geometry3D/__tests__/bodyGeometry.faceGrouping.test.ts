import { describe, it, expect } from 'vitest'
import type { Mesh3D } from '@/types/cad'
import {
  buildFaceBoundarySegments,
  extractFaceGeometry,
  groupTrianglesByFace,
  lazyFaceTriangles,
} from '@/components/Geometry3D/bodyGeometry'

/**
 * `buildFaceBoundarySegments` used to find its face's triangles by scanning the
 * whole mesh, so building the outline of every face -- which is what Body3D and
 * the assembly pick bundle both do -- cost O(faces x triangles). Measured on this
 * box at 20 000 faces / 400 000 triangles: 12 s per body, run synchronously
 * between the finished solve and the first painted frame. Grouping the triangles
 * once makes it linear.
 */

// A strip of quads: quad f is two triangles over vertices 2f..2f+3, so face f
// shares one edge with each neighbour and has a 4-edge boundary of its own.
function quadStrip(numFaces: number): Mesh3D {
  const numTris = numFaces * 2
  const vertices = new Float32Array((numFaces + 1) * 2 * 3)
  for (let i = 0; i <= numFaces; i++) {
    vertices[i * 6] = i; vertices[i * 6 + 1] = 0; vertices[i * 6 + 2] = 0
    vertices[i * 6 + 3] = i; vertices[i * 6 + 4] = 1; vertices[i * 6 + 5] = 0
  }
  const faces = new Uint32Array(numTris * 3)
  const triangle_to_face = new Uint32Array(numTris)
  for (let f = 0; f < numFaces; f++) {
    const a = f * 2, b = a + 1, c = a + 2, d = a + 3
    faces.set([a, b, c], f * 6)
    faces.set([b, d, c], f * 6 + 3)
    triangle_to_face[f * 2] = f
    triangle_to_face[f * 2 + 1] = f
  }
  return { vertices, faces, triangle_to_face }
}

describe('groupTrianglesByFace', () => {
  it('buckets every triangle under its B-rep face', () => {
    const groups = groupTrianglesByFace(quadStrip(3))!
    expect(groups.get(0)).toEqual([0, 1])
    expect(groups.get(1)).toEqual([2, 3])
    expect(groups.get(2)).toEqual([4, 5])
    expect(groups.size).toBe(3)
  })

  it('is null for a mesh with no triangle_to_face', () => {
    const { vertices, faces } = quadStrip(1)
    expect(groupTrianglesByFace({ vertices, faces })).toBeNull()
  })
})

describe('lazyFaceTriangles', () => {
  it('answers with an empty list for a face that owns no triangles', () => {
    // Never undefined for a mesh that HAS the metadata: undefined sends the
    // caller back to a full-mesh scan that is guaranteed to find nothing.
    expect(lazyFaceTriangles(quadStrip(2)).get(99)).toEqual([])
  })

  it('is undefined only when the mesh carries no triangle_to_face at all', () => {
    const { vertices, faces } = quadStrip(1)
    expect(lazyFaceTriangles({ vertices, faces }).get(0)).toBeUndefined()
  })

  it('groups once and serves every later face from the same pass', () => {
    const lookup = lazyFaceTriangles(quadStrip(3))
    expect(lookup.get(1)).toEqual([2, 3])
    expect(lookup.get(1)).toBe(lookup.get(1))
    expect(lookup.get(2)).toEqual([4, 5])
  })
})

describe('buildFaceBoundarySegments with a triangle list', () => {
  const mesh = quadStrip(4)

  it('matches the scanning path face for face', () => {
    const lookup = lazyFaceTriangles(mesh)
    for (let f = 0; f < 4; f++) {
      expect([...buildFaceBoundarySegments(mesh, f, lookup.get(f))])
        .toEqual([...buildFaceBoundarySegments(mesh, f)])
    }
  })

  it('a middle face of the strip keeps only its 4 boundary edges', () => {
    // The shared diagonal is interior (two triangles), the strip seams are not
    // shared WITHIN the face, so all four sides survive.
    expect(buildFaceBoundarySegments(mesh, 1, lazyFaceTriangles(mesh).get(1)).length).toBe(4 * 2 * 3)
  })

  it('uses the list it is handed rather than re-deriving it from the face index', () => {
    // Face 99 does not exist; handed face 0's triangles it must still produce
    // face 0's outline. This is what proves the scan is actually bypassed.
    expect([...buildFaceBoundarySegments(mesh, 99, [0, 1])])
      .toEqual([...buildFaceBoundarySegments(mesh, 0)])
  })

  it('extractFaceGeometry takes the same shortcut', () => {
    const lookup = lazyFaceTriangles(mesh)
    expect(extractFaceGeometry(mesh, 2, lookup.get(2))).toEqual(extractFaceGeometry(mesh, 2))
    expect(extractFaceGeometry(mesh, 99, [4, 5])).toEqual(extractFaceGeometry(mesh, 2))
  })

  it('builds every face of a heavy mesh in linear time', () => {
    // 20k faces / 40k triangles. The old full-scan-per-face version needs ~12s
    // here; grouping first lands around 100 ms, so this budget is a real
    // red-green guard and not a machine-speed lottery.
    const heavy = quadStrip(20000)
    const lookup = lazyFaceTriangles(heavy)
    const started = performance.now()
    let totalFloats = 0
    for (let f = 0; f < 20000; f++) {
      totalFloats += buildFaceBoundarySegments(heavy, f, lookup.get(f)).length
    }
    expect(totalFloats).toBe(20000 * 4 * 2 * 3)
    expect(performance.now() - started).toBeLessThan(2000)
  })
})
