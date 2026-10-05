import { describe, it, expect, vi } from 'vitest'

// The real VERTEX_POINT_KEYS set has no entry that is a suffix of another, so a
// bare string can match at most one key and the tie-break is unreachable in
// production. This file mocks an adversarial set ('1' is a suffix of 'c1') to
// pin the rule the shared reader must keep: among splits that land on a known
// id, the longest eid (shortest key) wins, independent of the key list order.
// The tie-break drifted once between the four copies; this keeps it fixed.
vi.mock('./vertexKeys', () => ({
  VERTEX_POINT_KEYS: ['c1', '1'] as const,
}))

import { resolveVertexRef } from './vertexRef'

describe('resolveVertexRef longest-eid tie-break', () => {
  it('picks the longest eid when two suffixes both land on a known id', () => {
    // '$abc1': key 'c1' -> eid 'ab' (known), key '1' -> eid 'abc' (known).
    // Longest eid is 'abc' even though 'c1' comes first in the mocked key list.
    const known = new Set(['ab', 'abc'])
    expect(resolveVertexRef(known, '$abc1')).toEqual({ entity: 'abc', point: '1' })
  })

  it('falls back to the shorter-eid split when the longest prefix is not known', () => {
    const known = new Set(['ab'])
    expect(resolveVertexRef(known, '$abc1')).toEqual({ entity: 'ab', point: 'c1' })
  })

  it('still lets a full entity id win over any split', () => {
    const known = new Set(['ab', 'abc', 'abc1'])
    expect(resolveVertexRef(known, '$abc1')).toEqual({ entity: 'abc1' })
  })

  it('validates dict points against the same (mocked) key set', () => {
    const known = new Set(['ab'])
    expect(resolveVertexRef(known, { entity: 'ab', point: '1' })).toEqual({ entity: 'ab', point: '1' })
    expect(resolveVertexRef(known, { entity: 'ab', point: 'end' })).toBeNull()
  })
})
