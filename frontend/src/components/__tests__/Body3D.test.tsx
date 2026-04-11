import { describe, it, expect } from 'vitest'
import { buildBodyGeometry } from '../Geometry3D/Body3D'
import type { Mesh3D } from '../../types/cad'

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
