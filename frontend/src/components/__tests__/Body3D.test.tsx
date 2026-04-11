import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { buildBodyGeometry, buildEdgeSegments } from '../Geometry3D/Body3D'
import type { Mesh3D } from '../../types/cad'
import { ARC_SEGMENTS } from '../Geometry3D/constants'

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
