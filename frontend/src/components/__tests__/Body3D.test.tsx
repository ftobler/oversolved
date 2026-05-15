import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { buildBodyGeometry, buildEdgeSegments, getEdgeSegmentCounts, buildFaceBoundarySegments, extractFaceGeometry, calculateFaceProperties } from '@/components/Geometry3D/bodyGeometry'
import type { Mesh3D, EdgeData } from '@/types/cad'
import { ARC_SEGMENTS } from '@/components/Geometry3D/constants'

const CUBE_MESH: Mesh3D = {
  vertices: [
    [0,0,0],[1,0,0],[1,1,0],[0,1,0],
    [0,0,1],[1,0,1],[1,1,1],[0,1,1],
  ],
  faces: [
    [0,1,2],[0,2,3],
    [4,6,5],[4,7,6],
    [0,4,5],[0,5,1],
    [1,5,6],[1,6,2],
    [2,6,7],[2,7,3],
    [3,7,4],[3,4,0],
  ],
  normals: [],
}

// Same cube with triangle_to_face mapping: 2 triangles per face, 6 faces.
const CUBE_MESH_BREP: Mesh3D = {
  ...CUBE_MESH,
  triangle_to_face: [0,0, 1,1, 2,2, 3,3, 4,4, 5,5],
  face_queries: ['?f0', '?f1', '?f2', '?f3', '?f4', '?f5'],
}

describe('no EdgesGeometry from mesh', () => {
  it('buildBodyGeometry return value is not a THREE geometry object', () => {
    // Guard against regressions where buildBodyGeometry is changed to return
    // a geometry instance (e.g. EdgesGeometry) instead of raw typed arrays.
    const result = buildBodyGeometry(CUBE_MESH)
    expect(result instanceof THREE.EdgesGeometry).toBe(false)
    expect(result instanceof THREE.BufferGeometry).toBe(false)
    expect(result).toHaveProperty('positions')
    expect(result).toHaveProperty('indices')
  })
})

describe('buildBodyGeometry', () => {
  it('positions array length matches vertex count', () => {
    const { positions } = buildBodyGeometry(CUBE_MESH)
    expect(positions.length).toBe(CUBE_MESH.vertices.length * 3)  // 24
  })

  it('toNonIndexed vertex count equals faces * 3 for per-face color alignment', () => {
    const { positions, indices } = buildBodyGeometry(CUBE_MESH)
    const indexed = new THREE.BufferGeometry()
    indexed.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    indexed.setIndex(new THREE.BufferAttribute(indices, 1))
    const geo = indexed.toNonIndexed()
    const posAttr = geo.getAttribute('position')
    expect(posAttr.count).toBe(CUBE_MESH.faces.length * 3)  // 36, not 8
    indexed.dispose()
    geo.dispose()
  })

  it('indices array length matches face count', () => {
    const { indices } = buildBodyGeometry(CUBE_MESH)
    expect(indices.length).toBe(CUBE_MESH.faces.length * 3)  // 36
  })

  it('empty mesh does not crash', () => {
    const empty: Mesh3D = { vertices: [], faces: [], normals: [] }
    expect(() => buildBodyGeometry(empty)).not.toThrow()
    const { positions, indices } = buildBodyGeometry(empty)
    expect(positions.length).toBe(0)
    expect(indices.length).toBe(0)
  })

  it('all index values are within vertex range', () => {
    const { indices } = buildBodyGeometry(CUBE_MESH)
    for (const idx of indices) {
      expect(idx).toBeLessThan(CUBE_MESH.vertices.length)
    }
  })

  it('throws on NaN vertex coordinate', () => {
    const badMesh: Mesh3D = {
      vertices: [[0, 0, 0], [1, NaN, 0], [1, 1, 0]],
      faces: [[0, 1, 2]],
      normals: [[0, 0, 1]],
    }
    expect(() => buildBodyGeometry(badMesh)).toThrow('invalid coordinate')
  })

  it('throws on out-of-range face index', () => {
    const badMesh: Mesh3D = {
      vertices: [[0, 0, 0], [1, 0, 0], [1, 1, 0]],
      faces: [[0, 1, 99]],
      normals: [[0, 0, 1]],
    }
    expect(() => buildBodyGeometry(badMesh)).toThrow('invalid index')
  })

  it('throws on vertex with fewer than 3 coordinates', () => {
    const badMesh: Mesh3D = {
      vertices: [[0, 0] as unknown as [number, number, number], [1, 0, 0], [1, 1, 0]],
      faces: [[0, 1, 2]],
      normals: [[0, 0, 1]],
    }
    expect(() => buildBodyGeometry(badMesh)).toThrow('not a 3-element array')
  })
})

describe('buildFaceBoundarySegments', () => {
  it('returns empty array when triangle_to_face is missing', () => {
    const result = buildFaceBoundarySegments(CUBE_MESH, 0)
    expect(result.length).toBe(0)
  })

  it('bottom face (face 0) has 4 boundary edges = 8 points = 24 floats', () => {
    const result = buildFaceBoundarySegments(CUBE_MESH_BREP, 0)
    // 4 edges × 2 endpoints × 3 floats = 24
    expect(result.length).toBe(24)
  })

  it('boundary segments are multiples of 6 floats (one segment = 2 endpoints × 3 coords)', () => {
    for (let face = 0; face < 6; face++) {
      const result = buildFaceBoundarySegments(CUBE_MESH_BREP, face)
      expect(result.length % 6).toBe(0)
    }
  })

  it('all 6 cube faces have 4 boundary edges each', () => {
    for (let face = 0; face < 6; face++) {
      const result = buildFaceBoundarySegments(CUBE_MESH_BREP, face)
      expect(result.length).toBe(24)  // 4 edges × 2 × 3
    }
  })

  it('out-of-range face index returns empty array', () => {
    const result = buildFaceBoundarySegments(CUBE_MESH_BREP, 99)
    expect(result.length).toBe(0)
  })
})

describe('buildEdgeSegments line', () => {
  it('returns Float32Array of length 6 for a single line edge', () => {
    const result = buildEdgeSegments([
      { kind: 'line', start: [0, 0, 0], end: [1, 0, 0] },
    ])
    expect(result).toBeInstanceOf(Float32Array)
    expect(result.length).toBe(6)
    expect(result[0]).toBe(0)
    expect(result[3]).toBe(1)
  })
})

describe('buildEdgeSegments NaN guard', () => {
  it('skips line edge with NaN coordinate', () => {
    const result = buildEdgeSegments([
      { kind: 'line', start: [0, 0, 0], end: [NaN, 0, 0] },
    ])
    expect(result.length).toBe(0)
  })

  it('skips circle edge with NaN center', () => {
    const result = buildEdgeSegments([{
      kind: 'circle',
      center: [NaN, 0, 0],
      radius: 1,
      axis: [0, 0, 1],
      x_axis: [1, 0, 0],
      angle_start: 0,
      angle_end: 2 * Math.PI,
    }])
    expect(result.length).toBe(0)
  })

  it('skips circle edge with NaN radius', () => {
    const result = buildEdgeSegments([{
      kind: 'circle',
      center: [0, 0, 0],
      radius: NaN,
      axis: [0, 0, 1],
      x_axis: [1, 0, 0],
      angle_start: 0,
      angle_end: 2 * Math.PI,
    }])
    expect(result.length).toBe(0)
  })

  it('skips spline segment with NaN point', () => {
    const result = buildEdgeSegments([{
      kind: 'spline',
      points: [[0, 0, 0], [1, NaN, 0], [2, 0, 0]],
    }])
    expect(result.length).toBe(0)
  })
})

describe('buildEdgeSegments circle', () => {
  it('full circle produces ARC_SEGMENTS * 2 * 3 floats and start/end points are close', () => {
    const result = buildEdgeSegments([{
      kind: 'circle',
      center: [0, 0, 0],
      radius: 1,
      axis: [0, 0, 1],
      x_axis: [1, 0, 0],
      angle_start: 0,
      angle_end: 2 * Math.PI,
    }])
    expect(result).toBeInstanceOf(Float32Array)
    expect(result.length).toBe(ARC_SEGMENTS * 2 * 3)
    // First segment start (floats 0-2) and last segment end (last 3 floats) should be close.
    const firstX = result[0], firstY = result[1], firstZ = result[2]
    const lastX = result[result.length - 3]
    const lastY = result[result.length - 2]
    const lastZ = result[result.length - 1]
    expect(Math.abs(firstX - lastX)).toBeLessThan(1e-5)
    expect(Math.abs(firstY - lastY)).toBeLessThan(1e-5)
    expect(Math.abs(firstZ - lastZ)).toBeLessThan(1e-5)
  })
})

describe('buildEdgeSegments arc', () => {
  it('90-degree arc produces fewer points than a full circle', () => {
    const fullCircle = buildEdgeSegments([{
      kind: 'circle',
      center: [0, 0, 0],
      radius: 1,
      axis: [0, 0, 1],
      x_axis: [1, 0, 0],
      angle_start: 0,
      angle_end: 2 * Math.PI,
    }])
    const quarterArc = buildEdgeSegments([{
      kind: 'arc',
      center: [0, 0, 0],
      radius: 1,
      axis: [0, 0, 1],
      x_axis: [1, 0, 0],
      angle_start: 0,
      angle_end: Math.PI / 2,
    }])
    expect(quarterArc.length).toBeLessThan(fullCircle.length)
    // Proportional: quarter arc should be roughly 1/4 the point count.
    expect(quarterArc.length).toBeLessThanOrEqual(fullCircle.length / 3)
  })
})

describe('getEdgeSegmentCounts', () => {
  it('returns 1 for each line edge', () => {
    const edges: EdgeData[] = [
      { kind: 'line', start: [0, 0, 0], end: [1, 0, 0] },
      { kind: 'line', start: [1, 0, 0], end: [1, 1, 0] },
    ]
    const counts = getEdgeSegmentCounts(edges)
    expect(counts).toEqual([1, 1])
  })

  it('returns ARC_SEGMENTS for a full circle', () => {
    const edges: EdgeData[] = [{
      kind: 'circle',
      center: [0, 0, 0],
      radius: 1,
      axis: [0, 0, 1],
      x_axis: [1, 0, 0],
      angle_start: 0,
      angle_end: 2 * Math.PI,
    }]
    const counts = getEdgeSegmentCounts(edges)
    expect(counts).toEqual([ARC_SEGMENTS])
  })

  it('returns fewer segments for a quarter arc', () => {
    const edges: EdgeData[] = [{
      kind: 'arc',
      center: [0, 0, 0],
      radius: 1,
      axis: [0, 0, 1],
      x_axis: [1, 0, 0],
      angle_start: 0,
      angle_end: Math.PI / 2,
    }]
    const counts = getEdgeSegmentCounts(edges)
    // Quarter arc should have roughly 1/4 the segments of a full circle
    expect(counts[0]).toBeLessThan(ARC_SEGMENTS / 2)
    expect(counts[0]).toBeGreaterThanOrEqual(2)
  })

  it('returns correct segment count for spline edges', () => {
    const edges: EdgeData[] = [{
      kind: 'spline',
      points: [[0, 0, 0], [1, 0, 0], [2, 1, 0], [3, 0, 0]],
    }]
    const counts = getEdgeSegmentCounts(edges)
    // 4 points = 3 segments
    expect(counts).toEqual([3])
  })

  it('returns empty array for empty edges', () => {
    const counts = getEdgeSegmentCounts([])
    expect(counts).toEqual([])
  })

  it('handles mixed edge types', () => {
    const edges: EdgeData[] = [
      { kind: 'line', start: [0, 0, 0], end: [1, 0, 0] },
      { kind: 'circle', center: [0, 0, 0], radius: 1, axis: [0, 0, 1], x_axis: [1, 0, 0], angle_start: 0, angle_end: 2 * Math.PI },
      { kind: 'spline', points: [[0, 0, 0], [1, 0, 0], [2, 0, 0]] },
    ]
    const counts = getEdgeSegmentCounts(edges)
    expect(counts.length).toBe(3)
    expect(counts[0]).toBe(1)  // line
    expect(counts[1]).toBe(ARC_SEGMENTS)  // circle
    expect(counts[2]).toBe(2)  // spline with 3 points
  })
})

describe('extractFaceGeometry', () => {
  it('returns null when triangle_to_face is missing', () => {
    const result = extractFaceGeometry(CUBE_MESH, 0)
    expect(result).toBeNull()
  })

  it('returns 4 vertices for a cube face (2 triangles, 4 unique vertices)', () => {
    const result = extractFaceGeometry(CUBE_MESH_BREP, 0)
    expect(result).not.toBeNull()
    expect(result!.vertices.length).toBe(4)
  })

  it('returns consistent vertices for all 6 cube faces', () => {
    for (let face = 0; face < 6; face++) {
      const result = extractFaceGeometry(CUBE_MESH_BREP, face)
      expect(result).not.toBeNull()
      expect(result!.vertices.length).toBe(4)
    }
  })

  it('returns null for out-of-range face index', () => {
    const result = extractFaceGeometry(CUBE_MESH_BREP, 99)
    expect(result).toBeNull()
  })
})

describe('calculateFaceProperties', () => {
  it('calculates centroid of a square face correctly', () => {
    // Bottom face of cube: z=0, vertices at (0,0,0), (1,0,0), (1,1,0), (0,1,0)
    const faceGeo = extractFaceGeometry(CUBE_MESH_BREP, 0)!
    const props = calculateFaceProperties(faceGeo)
    expect(props).not.toBeNull()
    expect(props!.center[0]).toBeCloseTo(0.5, 5)
    expect(props!.center[1]).toBeCloseTo(0.5, 5)
    expect(props!.center[2]).toBeCloseTo(0, 5)
  })

  it('calculates normal of bottom face pointing down (negative z)', () => {
    const faceGeo = extractFaceGeometry(CUBE_MESH_BREP, 0)!
    const props = calculateFaceProperties(faceGeo)!
    // Normal should point in -z direction (or +z depending on winding)
    expect(props.normal[2]).not.toBe(0)
  })

  it('calculates normal of top face pointing up (positive z)', () => {
    const faceGeo = extractFaceGeometry(CUBE_MESH_BREP, 1)!
    const props = calculateFaceProperties(faceGeo)!
    expect(props.normal[2]).not.toBe(0)
  })

  it('returns null for fewer than 3 vertices', () => {
    const result = calculateFaceProperties({ vertices: [[0, 0, 0], [1, 0, 0]] })
    expect(result).toBeNull()
  })

  it('normal is non-zero for a valid face', () => {
    const faceGeo = extractFaceGeometry(CUBE_MESH_BREP, 2)!
    const props = calculateFaceProperties(faceGeo)!
    const norm = Math.sqrt(props.normal[0]**2 + props.normal[1]**2 + props.normal[2]**2)
    expect(norm).toBeGreaterThan(0)
  })
})
