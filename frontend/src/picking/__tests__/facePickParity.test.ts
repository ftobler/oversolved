import { describe, it, expect } from 'vitest'
import { IdRegistry } from '../IdRegistry'
import { FaceIdLayer, FACE_LAYER_NAME } from '../FaceIdLayer'
import { rgbToId } from '../idEncoding'

/**
 * Structural parity test: for every triangle in a registered body, the ID
 * layer's encoded face color decodes (via the registry) to the SAME entity
 * key that Body3D.resolveFaceQuery() returns for the same triangle index.
 *
 * This is the slice-1 equivalent of the run-time parity check in the plan.
 * The full "render-and-readPixels" parity belongs to GPU-backed test
 * infrastructure that doesn't exist in vitest+jsdom; it's documented as a
 * manual smoke step in id-buffer-core.md and revisited in #267.
 */

function resolveFaceQueryReference(
  triangleIndex: number,
  triangleToFace: ArrayLike<number>,
  faceQueries: ReadonlyArray<string>,
): string | null {
  const faceIdx = triangleToFace[triangleIndex]
  if (faceIdx === undefined) return null
  return faceQueries[faceIdx] ?? null
}

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
  it('every triangle decodes to the same entity key as the raycaster path', () => {
    // Fixture: a faux "cube-ish" body with 12 triangles spread across 6 faces.
    const NUM_FACES = 6
    const TRIS_PER_FACE = 2
    const NUM_TRIS = NUM_FACES * TRIS_PER_FACE
    const positions = new Float32Array(NUM_TRIS * 9)
    // Positions are irrelevant for the structural check; just need a valid shape.
    for (let i = 0; i < positions.length; i++) positions[i] = i * 0.001

    const triangleToFace = new Uint32Array(NUM_TRIS)
    for (let t = 0; t < NUM_TRIS; t++) triangleToFace[t] = Math.floor(t / TRIS_PER_FACE)

    const faceQueries = Array.from({ length: NUM_FACES }, (_, i) => `face@cube#${i}`)

    const reg = new IdRegistry()
    const layer = new FaceIdLayer(reg)
    layer.registerBody({ bodyKey: 'cube', positions, triangleToFace, faceQueries })

    const mesh = layer.scene.children[0] as import('three').Mesh

    for (let tri = 0; tri < NUM_TRIS; tri++) {
      const idFromPipeline = decodeTriangleId(mesh, tri)
      const recordFromPipeline = reg.lookup(idFromPipeline)
      expect(recordFromPipeline).toBeDefined()
      expect(recordFromPipeline!.layer).toBe(FACE_LAYER_NAME)

      const keyFromRaycaster = resolveFaceQueryReference(tri, triangleToFace, faceQueries)
      expect(recordFromPipeline!.entityKey).toBe(keyFromRaycaster)
    }

    layer.dispose()
  })

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
