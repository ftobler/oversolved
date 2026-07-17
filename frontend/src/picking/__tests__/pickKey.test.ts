import { describe, it, expect } from 'vitest'
import { bodyKeyFor, primitivePickKey, pickedPrimitiveIndex } from '../pickKey'
import { FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME } from '../layerNames'

describe('primitivePickKey', () => {
  const body = bodyKeyFor('extrude1', 'body0')

  it('is stable for the same body / layer / index', () => {
    expect(primitivePickKey(body, 3, FACE_LAYER_NAME)).toBe(primitivePickKey(body, 3, FACE_LAYER_NAME))
  })

  it('differs across layers at the same index (back-mapping stays unique)', () => {
    const face = primitivePickKey(body, 2, FACE_LAYER_NAME)
    const edge = primitivePickKey(body, 2, EDGE_LAYER_NAME)
    const vertex = primitivePickKey(body, 2, VERTEX_LAYER_NAME)
    expect(new Set([face, edge, vertex]).size).toBe(3)
  })

  it('differs across indices within a layer', () => {
    expect(primitivePickKey(body, 0, EDGE_LAYER_NAME)).not.toBe(primitivePickKey(body, 1, EDGE_LAYER_NAME))
  })

  it('differs across bodies at the same layer / index', () => {
    const a = primitivePickKey(bodyKeyFor('f', 'b0'), 0, FACE_LAYER_NAME)
    const b = primitivePickKey(bodyKeyFor('f', 'b1'), 0, FACE_LAYER_NAME)
    expect(a).not.toBe(b)
  })
})

describe('pickedPrimitiveIndex (id -> element back-mapping)', () => {
  const body = bodyKeyFor('extrude1', 'body0')

  it('resolves the index of a pick key minted for the same layer', () => {
    const key = primitivePickKey(body, 3, EDGE_LAYER_NAME)
    expect(pickedPrimitiveIndex(body, 5, EDGE_LAYER_NAME, key)).toBe(3)
  })

  it('returns -1 for a null pick key', () => {
    expect(pickedPrimitiveIndex(body, 5, EDGE_LAYER_NAME, null)).toBe(-1)
  })

  it('does not resolve a pick key from another layer at the same index', () => {
    // A hovered vertex must never light up the same-index edge / face.
    const vertexKey = primitivePickKey(body, 2, VERTEX_LAYER_NAME)
    expect(pickedPrimitiveIndex(body, 5, EDGE_LAYER_NAME, vertexKey)).toBe(-1)
    expect(pickedPrimitiveIndex(body, 5, FACE_LAYER_NAME, vertexKey)).toBe(-1)
  })

  it('does not resolve a pick key from another body', () => {
    const otherKey = primitivePickKey(bodyKeyFor('extrude1', 'body1'), 1, EDGE_LAYER_NAME)
    expect(pickedPrimitiveIndex(body, 5, EDGE_LAYER_NAME, otherKey)).toBe(-1)
  })
})
