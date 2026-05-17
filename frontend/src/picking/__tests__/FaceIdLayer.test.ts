import { describe, it, expect, beforeEach } from 'vitest'
import { IdRegistry } from '../IdRegistry'
import { FaceIdLayer, FACE_LAYER_NAME } from '../FaceIdLayer'
import { rgbToId } from '../idEncoding'

function makeRegistration() {
  // Two triangles, two faces. Triangle 0 -> face 0, triangle 1 -> face 1.
  const positions = new Float32Array([
    // tri 0 (face 0)
    0, 0, 0,  1, 0, 0,  0, 1, 0,
    // tri 1 (face 1)
    1, 1, 0,  2, 1, 0,  1, 2, 0,
  ])
  return {
    bodyKey: 'feat1/body1',
    positions,
    triangleToFace: new Uint32Array([0, 1]),
    faceQueries: ['face@feat1#0', 'face@feat1#1'],
  }
}

describe('FaceIdLayer', () => {
  let reg: IdRegistry
  let layer: FaceIdLayer
  beforeEach(() => {
    reg = new IdRegistry()
    layer = new FaceIdLayer(reg)
  })

  it('registers one mesh per body', () => {
    expect(layer.bodyCount()).toBe(0)
    layer.registerBody(makeRegistration())
    expect(layer.bodyCount()).toBe(1)
    expect(layer.scene.children.length).toBe(1)
  })

  it('allocates one id per distinct face query', () => {
    layer.registerBody(makeRegistration())
    expect(reg.size()).toBe(2)
    expect(reg.lookupKey(FACE_LAYER_NAME, 'face@feat1#0')).toBeDefined()
    expect(reg.lookupKey(FACE_LAYER_NAME, 'face@feat1#1')).toBeDefined()
  })

  it('encodes per-triangle face color as the packed id RGB', () => {
    layer.registerBody(makeRegistration())
    const mesh = layer.scene.children[0] as import('three').Mesh
    const colorAttr = mesh.geometry.getAttribute('color')
    // Tri 0: all 3 vertices carry the id of face@feat1#0
    const id0 = reg.lookupKey(FACE_LAYER_NAME, 'face@feat1#0')!
    const id1 = reg.lookupKey(FACE_LAYER_NAME, 'face@feat1#1')!
    for (let v = 0; v < 3; v++) {
      const r = Math.round(colorAttr.getX(v) * 255)
      const g = Math.round(colorAttr.getY(v) * 255)
      const b = Math.round(colorAttr.getZ(v) * 255)
      expect(rgbToId(r, g, b)).toBe(id0)
    }
    for (let v = 3; v < 6; v++) {
      const r = Math.round(colorAttr.getX(v) * 255)
      const g = Math.round(colorAttr.getY(v) * 255)
      const b = Math.round(colorAttr.getZ(v) * 255)
      expect(rgbToId(r, g, b)).toBe(id1)
    }
  })

  it('unregister removes the mesh and frees its ids next cycle', () => {
    layer.registerBody(makeRegistration())
    expect(reg.size()).toBe(2)
    layer.unregisterBody('feat1/body1')
    expect(layer.bodyCount()).toBe(0)
    expect(layer.scene.children.length).toBe(0)
    expect(reg.size()).toBe(0)
  })

  it('re-registering with same key replaces the mesh', () => {
    layer.registerBody(makeRegistration())
    const firstMesh = layer.scene.children[0]
    layer.registerBody(makeRegistration())
    expect(layer.bodyCount()).toBe(1)
    expect(layer.scene.children[0]).not.toBe(firstMesh)
  })

  it('dispose clears every body and the material', () => {
    layer.registerBody(makeRegistration())
    layer.dispose()
    expect(layer.bodyCount()).toBe(0)
    expect(reg.size()).toBe(0)
  })

  it('rejects non-multiple-of-9 position arrays', () => {
    expect(() => layer.registerBody({
      bodyKey: 'bad',
      positions: new Float32Array(10),
      triangleToFace: new Uint32Array([0]),
      faceQueries: ['q'],
    })).toThrow()
  })

  it('skips triangles whose face index has no query', () => {
    // One triangle pointing at face 5, but only 2 queries -> the triangle's
    // face has no stable key, so no id is allocated for it.
    layer.registerBody({
      bodyKey: 'sparse',
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      triangleToFace: new Uint32Array([5]),
      faceQueries: ['q0', 'q1'],
    })
    expect(reg.size()).toBe(0)
  })
})
