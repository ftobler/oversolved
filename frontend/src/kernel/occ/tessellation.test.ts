import { describe, it, expect } from 'vitest'
import { assembleMesh, compareEdgeSortKeys, type RawFaceGeom } from './tessellation'
import type { Vec3 } from './primitives'

// A planar quad face as two triangles, with per-face 0-based indices.
function quad(centroid: Vec3, normal: Vec3, corners: [Vec3, Vec3, Vec3, Vec3]): RawFaceGeom {
  return {
    vertices: corners,
    triangles: [
      [0, 1, 2],
      [0, 2, 3],
    ],
    centroid,
    normal,
    surfaceType: 'flatface',
  }
}

describe('assembleMesh', () => {
  it('offsets per-face triangle indices into the global vertex list', () => {
    const faces: RawFaceGeom[] = [
      quad([0, 0, -1], [0, 0, -1], [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
      ]),
      quad([0, 0, 1], [0, 0, 1], [
        [0, 0, 2],
        [1, 0, 2],
        [1, 1, 2],
        [0, 1, 2],
      ]),
    ]
    const mesh = assembleMesh(faces)
    expect(mesh.vertices).toHaveLength(8)
    expect(mesh.faces).toHaveLength(4)
    // second face's triangles must reference vertices 4..7, not 0..3
    expect(mesh.faces[2]).toEqual([4, 5, 6])
    expect(mesh.faces[3]).toEqual([4, 6, 7])
  })

  it('builds triangle_to_face aligned with face_data ordering', () => {
    const faces: RawFaceGeom[] = [
      quad([0, 0, 1], [0, 0, 1], [
        [0, 0, 1],
        [1, 0, 1],
        [1, 1, 1],
        [0, 1, 1],
      ]),
      quad([0, 0, 0], [0, 0, -1], [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
      ]),
    ]
    const mesh = assembleMesh(faces)
    // sorted by normal: [0,0,-1] before [0,0,1], so the -Z face is index 0
    expect(mesh.face_data[0].normal).toEqual([0, 0, -1])
    expect(mesh.face_data[1].normal).toEqual([0, 0, 1])
    expect(mesh.triangle_to_face).toEqual([0, 0, 1, 1])
  })

  it('sorts flat faces before curved regardless of input order', () => {
    const curved: RawFaceGeom = {
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
      triangles: [[0, 1, 2]],
      centroid: [0, 0, 0],
      normal: [0, 0, 1],
      surfaceType: 'cylinderface',
    }
    const flat = quad([5, 5, 5], [1, 0, 0], [
      [5, 5, 5],
      [5, 6, 5],
      [5, 6, 6],
      [5, 5, 6],
    ])
    const mesh = assembleMesh([curved, flat])
    expect(mesh.face_data[0].surface_type).toBe('flatface')
    expect(mesh.face_data[1].surface_type).toBe('cylinderface')
  })

  it('accumulates per-face triangle-sum area', () => {
    const mesh = assembleMesh([
      quad([0, 0, 0], [0, 0, 1], [
        [0, 0, 0],
        [2, 0, 0],
        [2, 2, 0],
        [0, 2, 0],
      ]),
    ])
    expect(mesh.face_data[0].area).toBeCloseTo(4, 12) // 2x2 quad
  })

  it('drops a face with no triangles from face_data', () => {
    const empty: RawFaceGeom = {
      vertices: [],
      triangles: [],
      centroid: [9, 9, 9],
      normal: [1, 0, 0],
      surfaceType: 'flatface',
    }
    const real = quad([0, 0, 0], [0, 0, 1], [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
    ])
    const mesh = assembleMesh([empty, real])
    expect(mesh.face_data).toHaveLength(1)
  })
})

describe('compareEdgeSortKeys', () => {
  it('orders straight edges (type 0) before curved (type 1)', () => {
    const line = [0, 'line', 5, 5, 5, 9, 9, 9]
    const circle = [1, 'circle', 0, 0, 0, 3]
    expect(compareEdgeSortKeys(line, circle)).toBe(-1)
    expect(compareEdgeSortKeys(circle, line)).toBe(1)
  })

  it('orders curved kinds lexicographically (arc < circle < spline)', () => {
    const arc = [1, 'arc', 0, 0, 0]
    const circle = [1, 'circle', 0, 0, 0]
    const spline = [1, 'spline', 0, 0, 0]
    expect(compareEdgeSortKeys(arc, circle)).toBe(-1)
    expect(compareEdgeSortKeys(circle, spline)).toBe(-1)
  })

  it('breaks ties by the numeric coordinate fields', () => {
    const a = [0, 'line', 1, 0, 0, 0, 0, 0]
    const b = [0, 'line', 2, 0, 0, 0, 0, 0]
    expect(compareEdgeSortKeys(a, b)).toBe(-1)
    expect(compareEdgeSortKeys(b, a)).toBe(1)
    expect(compareEdgeSortKeys(a, a)).toBe(0)
  })

  it('sorts a mixed edge list deterministically', () => {
    const keys = [
      [1, 'circle', 0, 0, 10, 3],
      [0, 'line', 0, 0, 0, 0, 0, 5],
      [1, 'arc', 0, 0, 0, 10, 0, 1.57],
      [0, 'line', 0, 0, 0, 10, 0, 0],
    ]
    const sorted = [...keys].sort(compareEdgeSortKeys)
    expect(sorted.map((k) => k[1])).toEqual(['line', 'line', 'arc', 'circle'])
  })
})
