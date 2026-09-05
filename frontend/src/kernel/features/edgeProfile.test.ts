// Pure (no OCC) tests for edge-profile ref classification and the per-body edge
// index cache (extrude-brep-profile).

import { describe, it, expect, vi, afterEach } from 'vitest'
import { isEdgeProfileRef, resolveProfileEdges } from './edgeProfile'
import { makeEdgeIndexCache, resolveEdgesWithIndex, type EdgeIndex } from './filletChamfer'
import { Repository, makeAncestryQuery, ref } from '../query'
import type { OccModule, OccShape } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'

// The L11 cache sharing is what this file pins: resolveProfileEdges must build
// one edge index per body for the whole ref set, not one per ref. Wrapping the
// real makeEdgeIndexCache keeps the no-OCC cache-identity check real while the
// ref-loop test counts index builds through a recorder.
vi.mock('./filletChamfer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./filletChamfer')>()
  return {
    ...actual,
    makeEdgeIndexCache: vi.fn(actual.makeEdgeIndexCache),
    resolveEdgesWithIndex: vi.fn(actual.resolveEdgesWithIndex),
  }
})

const oc = null as unknown as OccModule
const scope = null as never
const table = null as unknown as HandleTable

afterEach(() => {
  vi.mocked(makeEdgeIndexCache).mockClear()
  vi.mocked(resolveEdgesWithIndex).mockReset()
})

describe('isEdgeProfileRef', () => {
  it('detects ancestry edge / straightedge type restrictions', () => {
    expect(isEdgeProfileRef(makeAncestryQuery([ref('gedge_abc'), ref('ex1')], 'edge'))).toBe(true)
    expect(isEdgeProfileRef(makeAncestryQuery([ref('gedge_abc'), ref('ex1')], 'straightedge'))).toBe(true)
  })

  it('detects the ?body:edge:N index alias', () => {
    expect(isEdgeProfileRef('?body_ex1:edge:0')).toBe(true)
    expect(isEdgeProfileRef('?body_ex1:straightedge:3')).toBe(true)
  })

  it('rejects sketch and face profile refs', () => {
    expect(isEdgeProfileRef('$sk1')).toBe(false)
    expect(isEdgeProfileRef('@ex1/top_face')).toBe(false)
    expect(isEdgeProfileRef(makeAncestryQuery([ref('gface_abc'), ref('ex1')], 'flatface'))).toBe(false)
    expect(isEdgeProfileRef(makeAncestryQuery([ref('gface_abc'), ref('ex1')], 'face'))).toBe(false)
  })
})

describe('makeEdgeIndexCache', () => {
  it('returns the same EdgeIndex for a repeated body id and a fresh one for a different id', () => {
    // buildEdgeIndex returns early on a null shape before touching oc, so the
    // cache can be probed without OCC.
    const indexFor = makeEdgeIndexCache(oc, scope, table)
    const bodyA = { id: 'body_a', shape: null } as unknown as Body
    const bodyB = { id: 'body_b', shape: null } as unknown as Body
    expect(indexFor(bodyA)).toBe(indexFor(bodyA))
    expect(indexFor(bodyA)).not.toBe(indexFor(bodyB))
  })
})

describe('resolveProfileEdges', () => {
  it('builds one edge index per body, not one per ref', () => {
    const dummyEdge = {} as unknown as OccShape
    vi.mocked(resolveEdgesWithIndex).mockReturnValue([dummyEdge])
    const makeBody = (id: string): Body =>
      ({
        id,
        created_by: 'ex1',
        modified_by: [],
        shape: {},
        sketch_id: 'sk',
        brep_diff: null,
        profile_queries: [],
      }) as unknown as Body
    const bodyStore: Record<string, Body> = {
      body_a: makeBody('body_a'),
      body_b: makeBody('body_b'),
      body_c: makeBody('body_c'),
    }
    // Four refs over three bodies, body_a resolved twice: the L11 contract is
    // one index build per distinct body for the whole ref set.
    const edgeRefs = [
      makeAncestryQuery([ref('ex1'), ref('body_a')], 'edge'),
      makeAncestryQuery([ref('ex1'), ref('body_b')], 'edge'),
      makeAncestryQuery([ref('ex1'), ref('body_c')], 'edge'),
      makeAncestryQuery([ref('ex1'), ref('body_a')], 'edge'),
    ]
    const built: string[] = []
    vi.mocked(makeEdgeIndexCache).mockImplementation(() => {
      // Mimic the real per-body caching so this recorder behaves like the real
      // cache whatever the test order; `built` only records cache misses.
      const seen = new Set<string>()
      const dummy = new Map<string, EdgeIndex>()
      return (body: Body): EdgeIndex => {
        if (!seen.has(body.id)) {
          seen.add(body.id)
          built.push(body.id)
        }
        let idx = dummy.get(body.id)
        if (idx === undefined) {
          idx = {
            queryToEdge: new Map(),
            ambiguousQueries: new Set(),
            ancestryRepo: new Repository(),
          }
          dummy.set(body.id, idx)
        }
        return idx
      }
    })

    const result = resolveProfileEdges(oc, scope, table, edgeRefs, bodyStore)

    expect(result).toHaveLength(4)
    // One cache above the ref loop, and no body's index is ever built twice.
    expect(vi.mocked(makeEdgeIndexCache)).toHaveBeenCalledTimes(1)
    expect(built.length).toBeLessThanOrEqual(3)
    expect(new Set(built).size).toBeLessThanOrEqual(3)
  })
})