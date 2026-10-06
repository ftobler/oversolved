import { describe, it, expect } from 'vitest'
import { encodeBinaryStl, stlTriangleCount, type StlMesh } from '../stl'

// A right triangle in the z=0 plane, wound counter-clockwise: its normal is +Z.
const TRI: StlMesh = {
  vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/** Read the count out of the header the way any STL reader would. */
function headerCount(bytes: Uint8Array): number {
  return view(bytes).getUint32(80, true)
}

function triangleAt(bytes: Uint8Array, i: number): { normal: number[]; corners: number[] } {
  const v = view(bytes)
  const at = 84 + i * 50
  const read = (o: number) => v.getFloat32(at + o, true)
  return {
    normal: [read(0), read(4), read(8)],
    corners: [
      read(12), read(16), read(20),
      read(24), read(28), read(32),
      read(36), read(40), read(44),
    ],
  }
}

describe('stlTriangleCount', () => {
  it('counts whole triangles across meshes', () => {
    expect(stlTriangleCount([TRI, TRI])).toBe(2)
  })

  it('ignores a trailing partial triangle rather than reading past the indices', () => {
    const ragged: StlMesh = { vertices: TRI.vertices, indices: new Uint32Array([0, 1, 2, 0, 1]) }
    expect(stlTriangleCount([ragged])).toBe(1)
    expect(encodeBinaryStl([ragged]).length).toBe(84 + 50)
  })
})

describe('encodeBinaryStl', () => {
  it('writes a self-describing buffer: 84-byte prefix + 50 bytes per triangle', () => {
    const bytes = encodeBinaryStl([TRI])
    expect(headerCount(bytes)).toBe(1)
    expect(bytes.length).toBe(84 + 50)
  })

  it('writes the corners in winding order and the derived normal', () => {
    const { normal, corners } = triangleAt(encodeBinaryStl([TRI]), 0)
    expect(normal).toEqual([0, 0, 1])
    expect(corners).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0])
  })

  it('flips the normal when the winding flips', () => {
    const flipped: StlMesh = { vertices: TRI.vertices, indices: new Uint32Array([0, 2, 1]) }
    expect(triangleAt(encodeBinaryStl([flipped]), 0).normal).toEqual([0, 0, -1])
  })

  it('concatenates meshes into one solid, each indexing its own vertices', () => {
    const shifted: StlMesh = {
      vertices: new Float32Array([5, 0, 0, 6, 0, 0, 5, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
    }
    const bytes = encodeBinaryStl([TRI, shifted])
    expect(headerCount(bytes)).toBe(2)
    // Mesh 2's index 0 must resolve against mesh 2's vertices, not mesh 1's.
    expect(triangleAt(bytes, 1).corners.slice(0, 3)).toEqual([5, 0, 0])
  })

  it('writes a zero normal for a degenerate triangle instead of NaN', () => {
    const degenerate: StlMesh = {
      vertices: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]),  // collinear
      indices: new Uint32Array([0, 1, 2]),
    }
    expect(triangleAt(encodeBinaryStl([degenerate]), 0).normal).toEqual([0, 0, 0])
  })

  it('encodes an empty mesh list as a zero-triangle solid', () => {
    const bytes = encodeBinaryStl([])
    expect(bytes.length).toBe(84)
    expect(headerCount(bytes)).toBe(0)
  })
})
