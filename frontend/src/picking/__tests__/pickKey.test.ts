// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { partKeyFor, primitivePickKey, pickedIndicesForPart, parsePickKeyIndex, isPickKeyString } from '../pickKey'
import { FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME } from '../layerNames'
import { IdPipeline } from '../IdPipeline'
import { setLivePipeline } from '../IdPipelineContext'
import { useFaceIdRegistration } from '../useFaceIdRegistration'
import { useEdgeIdRegistration } from '../useEdgeIdRegistration'
import { useVertexIdRegistration } from '../useVertexIdRegistration'
import type { Mesh3D, EdgeData } from '@/types/cad'

describe('primitivePickKey', () => {
  const part = partKeyFor('extrude1', 'body0')

  it('is stable for the same body / layer / index', () => {
    expect(primitivePickKey(part, 3, FACE_LAYER_NAME)).toBe(primitivePickKey(part, 3, FACE_LAYER_NAME))
  })

  it('differs across layers at the same index (back-mapping stays unique)', () => {
    const face = primitivePickKey(part, 2, FACE_LAYER_NAME)
    const edge = primitivePickKey(part, 2, EDGE_LAYER_NAME)
    const vertex = primitivePickKey(part, 2, VERTEX_LAYER_NAME)
    expect(new Set([face, edge, vertex]).size).toBe(3)
  })

  it('differs across indices within a layer', () => {
    expect(primitivePickKey(part, 0, EDGE_LAYER_NAME)).not.toBe(primitivePickKey(part, 1, EDGE_LAYER_NAME))
  })

  it('differs across bodies at the same layer / index', () => {
    const a = primitivePickKey(partKeyFor('f', 'b0'), 0, FACE_LAYER_NAME)
    const b = primitivePickKey(partKeyFor('f', 'b1'), 0, FACE_LAYER_NAME)
    expect(a).not.toBe(b)
  })
})

describe('parsePickKeyIndex (prefix + digit tail -> index)', () => {
  const part = partKeyFor('extrude1', 'body0')
  const prefix = `${part}#${EDGE_LAYER_NAME}#`

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

describe('isPickKeyString (structural pickKey test, no concrete prefix)', () => {
  it('accepts a well-formed pickKey', () => {
    expect(isPickKeyString('ex1/body_ex1#edge#3')).toBe(true)
  })

  it('accepts a pickKey whose bodyKey contains #, and agrees with parsePickKeyIndex', () => {
    expect(isPickKeyString('ex1/bo#dy#edge#3')).toBe(true)
    expect(parsePickKeyIndex('ex1/bo#dy#edge#3', 'ex1/bo#dy#edge#')).toBe(3)
  })

  it('rejects a bare query', () => {
    expect(isPickKeyString('?4;@ex1:edge')).toBe(false)
    expect(isPickKeyString('@builtin_plane_xy')).toBe(false)
  })

  it('rejects a non-integer index tail', () => {
    expect(isPickKeyString('a#b#c')).toBe(false)
  })

  it('rejects an empty bodyKey or layer', () => {
    expect(isPickKeyString('#edge#3')).toBe(false)
    expect(isPickKeyString('b##3')).toBe(false)
  })
})

describe('pickedIndicesForBody (pick set -> this body/layer)', () => {
  const part = partKeyFor('extrude1', 'body0')
  const other = partKeyFor('extrude1', 'body1')

  it('collects every index the pick set claims in this body / layer', () => {
    const keys = new Set([primitivePickKey(part, 4, EDGE_LAYER_NAME), primitivePickKey(part, 7, EDGE_LAYER_NAME)])
    expect([...pickedIndicesForPart(keys, part, EDGE_LAYER_NAME)!].sort()).toEqual([4, 7])
  })

  it('returns null when nothing in the set belongs here (the skip-everything path)', () => {
    // A pick living in another body or another layer must leave this body with no
    // claims at all, so the caller can bypass the claim logic entirely.
    const keys = new Set([
      primitivePickKey(other, 4, EDGE_LAYER_NAME),
      primitivePickKey(part, 4, VERTEX_LAYER_NAME),
    ])
    expect(pickedIndicesForPart(keys, part, EDGE_LAYER_NAME)).toBeNull()
    expect(pickedIndicesForPart(new Set<string>(), part, EDGE_LAYER_NAME)).toBeNull()
  })

  it('ignores a key whose tail is not a bare index', () => {
    expect(pickedIndicesForPart(new Set([`${part}#${EDGE_LAYER_NAME}#2x`]), part, EDGE_LAYER_NAME)).toBeNull()
  })

  it('drops only the indices at or beyond a provided count', () => {
    // The highlight path passes the body primitive count it already holds, so
    // an out-of-range pick key cannot even enter the claimed set.
    const keys = new Set([
      primitivePickKey(part, 2, EDGE_LAYER_NAME),
      primitivePickKey(part, 9, EDGE_LAYER_NAME),
    ])
    expect([...pickedIndicesForPart(keys, part, EDGE_LAYER_NAME, 5)!]).toEqual([2])
  })

  it('costs the size of the pick set, not the size of the body', () => {
    // The old direction minted a key per primitive to test against the set. With
    // a single live pick this must not touch the body's primitive count at all,
    // which is only observable as: the call carries no per-body allocation.
    const keys = new Set([primitivePickKey(part, 12345, FACE_LAYER_NAME)])
    expect([...pickedIndicesForPart(keys, part, FACE_LAYER_NAME)!]).toEqual([12345])
  })
})

describe('body key single source', () => {
  const FID = 'extrude1'
  const BID = 'body0'

  const faceMesh: Mesh3D = {
    vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    faces: new Uint32Array([0, 1, 2]),
    triangle_to_face: [0],
    face_queries: ['face@q0'],
  }
  const edges: EdgeData[] = [{ kind: 'line', start: [0, 0, 0], end: [1, 0, 0] }]
  const edgeQueries = ['edge@q0']
  const vertices: [number, number, number][] = [[0, 0, 0]]
  const vertexQueries = ['vtx@q0']

  // One entry per registration hook. The layer mints per-primitive pick keys
  // from the body key it was registered under, so a key derived from
  // `bodyKeyFor` resolving in the registry proves the hook handed the layer
  // exactly that body key -- and a divergent one would not resolve, keying the
  // assertion to the bodyKeyFor format instead of "something got registered".
  const cases: [string, () => void][] = [
    [FACE_LAYER_NAME, () => useFaceIdRegistration({ featureId: FID, partId: BID, mesh: faceMesh })],
    [EDGE_LAYER_NAME, () => useEdgeIdRegistration({ featureId: FID, partId: BID, edges, edgeQueries })],
    [VERTEX_LAYER_NAME, () => useVertexIdRegistration({ featureId: FID, partId: BID, vertices, vertexQueries })],
  ]

  it.each(cases)('the %s registration hook registers under the bodyKeyFor body key', (layer, render) => {
    const p = new IdPipeline({ width: 100, height: 100 })
    setLivePipeline(p)
    try {
      const { unmount } = renderHook(render)
      const expected = primitivePickKey(partKeyFor(FID, BID), 0, layer)
      expect(p.registry.lookupKey(layer, expected)).toBeDefined()
      expect(p.registry.lookupKey(layer, primitivePickKey('divergent/body', 0, layer))).toBeUndefined()
      unmount()
    } finally {
      setLivePipeline(null)
      p.dispose()
    }
  })

  // The registration hooks above prove the string the ID layers get, so the
  // only mint site without a behavior route is Part3D, which recomputes the
  // same key for the dispatch registry. A source pin there is the cheap guard
  // that the re-typed literal does not creep back (the format lives only in
  // pickKey.ts).
  it('Body3D does not re-type the `${featureId}/${bodyId}` literal', () => {
    const file = join(__dirname, '..', '..', 'components', 'Geometry3D', 'Part3D.tsx')
    const src = readFileSync(file, 'utf8')
    expect(src, file).not.toMatch(/\$\{featureId\}\/\$\{bodyId\}/)
    expect(src, file).toMatch(/partKeyFor\(/)
  })
})
