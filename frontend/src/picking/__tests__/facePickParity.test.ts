import { describe, it, expect } from 'vitest'
import { IdRegistry } from '../IdRegistry'
import { FaceIdLayer } from '../FaceIdLayer'
import { rgbToId } from '../idEncoding'

/**
 * Structural checks on the ID layer's encoded face colors. Body3D.resolveFaceQuery
 * does the same `faceQueries[triangleToFace[tri]]` lookup, but it lives inside a
 * React hook and cannot be imported; asserting parity against a local copy of
 * that one-liner would only compare the copy to itself. The real resolver path
 * is covered by Body3D's component tests.
 *
 * The full "render-and-readPixels" parity belongs to GPU-backed test
 * infrastructure that doesn't exist in vitest+jsdom; it's documented as a
 * manual smoke step in id-buffer-core.md and revisited in #267.
 */

function decodeTriangleId(
  mesh: import('three').Mesh,
  triangleIndex: number,
): number {
  const colorAttr = mesh.geometry.getAttribute('color')
  const v0 = triangleIndex * 3
  const r = Math.round(colorAttr.getX(v0) * 255)
  const g = Math.round(colorAttr.getY(v0) * 255)
  const b = Math.round(colorAttr.getZ(v0) * 255)
  return rgbToId(r, g, b)
}

describe('facePickParity (structural)', () => {
  it('faces with multiple triangles share one id (the same face)', () => {
    const positions = new Float32Array(6 * 9)
    const triangleToFace = new Uint32Array([0, 0, 0, 1, 1, 1])  // 3 tris per face
    const faceQueries = ['face@A', 'face@B']
    const reg = new IdRegistry()
    const layer = new FaceIdLayer(reg)
    layer.registerBody({ bodyKey: 'b', positions, triangleToFace, faceQueries })

    const mesh = layer.scene.children[0] as import('three').Mesh
    const idTri0 = decodeTriangleId(mesh, 0)
    const idTri1 = decodeTriangleId(mesh, 1)
    const idTri2 = decodeTriangleId(mesh, 2)
    const idTri3 = decodeTriangleId(mesh, 3)
    expect(idTri0).toBe(idTri1)
    expect(idTri1).toBe(idTri2)
    expect(idTri3).not.toBe(idTri0)

    layer.dispose()
  })
})
