import { describe, it, expect } from 'vitest'
import { bodyKeyFor, primitivePickKey, pickedIndicesForBody, parsePickKeyIndex } from '../pickKey'
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

describe('parsePickKeyIndex (prefix + digit tail -> index)', () => {
  const body = bodyKeyFor('extrude1', 'body0')
  const prefix = `${body}#${EDGE_LAYER_NAME}#`

  it('resolves a normal digit tail', () => {
    expect(parsePickKeyIndex(`${prefix}7`, prefix)).toBe(7)
  })

  it('rejects an over-precision tail above Number.MAX_SAFE_INTEGER', () => {
    // 2^53 + 1 cannot be represented exactly: Number rounds it onto a neighbor,
    // so two distinct tails would collapse onto one set entry and alias a real
    // primitive. The parser must reject it outright.
    expect(parsePickKeyIndex(`${prefix}9007199254740993`, prefix)).toBe(-1)
  })

  it('rejects an absurdly long tail that would overflow to Infinity', () => {
    expect(parsePickKeyIndex(`${prefix}${'9'.repeat(100)}`, prefix)).toBe(-1)
  })

  it('bounds the index by a finite count when one is given', () => {
    expect(parsePickKeyIndex(`${prefix}4`, prefix, 5)).toBe(4)
    expect(parsePickKeyIndex(`${prefix}9`, prefix, 5)).toBe(-1)
  })
})

describe('pickedIndicesForBody (pick set -> this body/layer)', () => {
  const body = bodyKeyFor('extrude1', 'body0')
  const other = bodyKeyFor('extrude1', 'body1')

  it('collects every index the pick set claims in this body / layer', () => {
    const keys = new Set([primitivePickKey(body, 4, EDGE_LAYER_NAME), primitivePickKey(body, 7, EDGE_LAYER_NAME)])
    expect([...pickedIndicesForBody(keys, body, EDGE_LAYER_NAME)!].sort()).toEqual([4, 7])
  })

  it('returns null when nothing in the set belongs here (the skip-everything path)', () => {
    // A pick living in another body or another layer must leave this body with no
    // claims at all, so the caller can bypass the claim logic entirely.
    const keys = new Set([
      primitivePickKey(other, 4, EDGE_LAYER_NAME),
      primitivePickKey(body, 4, VERTEX_LAYER_NAME),
    ])
    expect(pickedIndicesForBody(keys, body, EDGE_LAYER_NAME)).toBeNull()
    expect(pickedIndicesForBody(new Set<string>(), body, EDGE_LAYER_NAME)).toBeNull()
  })

  it('ignores a key whose tail is not a bare index', () => {
    expect(pickedIndicesForBody(new Set([`${body}#${EDGE_LAYER_NAME}#2x`]), body, EDGE_LAYER_NAME)).toBeNull()
  })

  it('drops only the indices at or beyond a provided count', () => {
    // The highlight path passes the body primitive count it already holds, so
    // an out-of-range pick key cannot even enter the claimed set.
    const keys = new Set([
      primitivePickKey(body, 2, EDGE_LAYER_NAME),
      primitivePickKey(body, 9, EDGE_LAYER_NAME),
    ])
    expect([...pickedIndicesForBody(keys, body, EDGE_LAYER_NAME, 5)!]).toEqual([2])
  })

  it('costs the size of the pick set, not the size of the body', () => {
    // The old direction minted a key per primitive to test against the set. With
    // a single live pick this must not touch the body's primitive count at all,
    // which is only observable as: the call carries no per-body allocation.
    const keys = new Set([primitivePickKey(body, 12345, FACE_LAYER_NAME)])
    expect([...pickedIndicesForBody(keys, body, FACE_LAYER_NAME)!]).toEqual([12345])
  })
})
