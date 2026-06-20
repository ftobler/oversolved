import { describe, it, expect } from 'vitest'
import {
  sel,
  selectionKey,
  parseSelectionId,
  selectionToQuery,
  topoFallbackQuery,
  parseTopoFallbackQuery,
  emitAbsoluteSelectionQuery,
} from '@/utils/query/selectionId'

describe('selectionKey <-> parseSelectionId round trip', () => {
  // parseSelectionId(selectionKey(s)) must recover the original SelectionId for
  // every kind. This is the load-bearing identity contract for Set membership
  // and React keys, so pin all six kinds.
  it('round trips entity', () => {
    const s = sel.entity('F1', 'L1')
    expect(selectionKey(s)).toBe('entity:F1:L1')
    expect(parseSelectionId(selectionKey(s))).toEqual(s)
  })

  it('round trips vertex', () => {
    const s = sel.vertex('F1', 'L1', 'start')
    expect(selectionKey(s)).toBe('vertex:F1:L1:start')
    expect(parseSelectionId(selectionKey(s))).toEqual(s)
  })

  it('round trips plane', () => {
    const s = sel.plane('F1')
    expect(selectionKey(s)).toBe('@F1')
    expect(parseSelectionId(selectionKey(s))).toEqual(s)
  })

  it('round trips constraint', () => {
    const s = sel.constraint('F1', 'c3')
    expect(selectionKey(s)).toBe('constraint:F1:c3')
    expect(parseSelectionId(selectionKey(s))).toEqual(s)
  })

  it('round trips face whose query itself contains colons', () => {
    // _splitFace must only split on the FIRST colon after `face:` so a query
    // carrying its own `:` (type restriction) survives intact.
    const s = sel.face('F1', '?2;ab:line@outer')
    expect(selectionKey(s)).toBe('face:F1:?2;ab:line@outer')
    expect(parseSelectionId(selectionKey(s))).toEqual(s)
  })

  it('round trips edge whose query itself contains colons', () => {
    const s = sel.edge('F1', '?2;ab:line')
    expect(selectionKey(s)).toBe('edge:F1:?2;ab:line')
    expect(parseSelectionId(selectionKey(s))).toEqual(s)
  })

  it('throws on an unrecognized selection id', () => {
    expect(() => parseSelectionId('bogus:F1')).toThrow(/Unrecognized selection ID/)
  })
})

describe('selectionToQuery', () => {
  it('emits a local query when the entity belongs to the host feature', () => {
    expect(selectionToQuery(sel.entity('F1', 'L1'), 'F1')).toEqual({ kind: 'local', eid: 'L1' })
  })

  it('emits an absolute query when the entity belongs to another feature', () => {
    expect(selectionToQuery(sel.entity('F1', 'L1'), 'OTHER')).toEqual({
      kind: 'absolute',
      featureId: 'F1',
      eid: 'L1',
    })
  })

  it('carries the sub key for vertex selections (local and absolute)', () => {
    expect(selectionToQuery(sel.vertex('F1', 'L1', 'end'), 'F1')).toEqual({
      kind: 'local',
      eid: 'L1',
      sub: 'end',
    })
    expect(selectionToQuery(sel.vertex('F1', 'L1', 'end'), 'OTHER')).toEqual({
      kind: 'absolute',
      featureId: 'F1',
      eid: 'L1',
      sub: 'end',
    })
  })

  it('emits an absolute query for a plane regardless of host', () => {
    expect(selectionToQuery(sel.plane('F1'), 'F1')).toEqual({ kind: 'absolute', featureId: 'F1' })
  })

  it('parses the inner query for face/edge selections', () => {
    expect(selectionToQuery(sel.face('F1', '$L1'), 'F1')).toEqual({ kind: 'local', eid: 'L1' })
  })

  it('refuses to use a constraint as a geometry target', () => {
    expect(() => selectionToQuery(sel.constraint('F1', 'c1'), 'F1')).toThrow(/Constraints cannot/)
  })
})

describe('topoFallbackQuery <-> parseTopoFallbackQuery', () => {
  it('round trips each body element kind', () => {
    for (const kind of ['edge', 'face', 'vertex'] as const) {
      const q = topoFallbackQuery('F1', kind, 7)
      expect(q).toBe(`@F1/${kind}/7`)
      expect(parseTopoFallbackQuery(q)).toEqual({ featureId: 'F1', kind, idx: 7 })
    }
  })

  it('returns null when the string is not a topo-fallback query', () => {
    expect(parseTopoFallbackQuery('entity:F1:L1')).toBeNull()  // no leading @
    expect(parseTopoFallbackQuery('@F1/edge')).toBeNull()  // missing second slash
    expect(parseTopoFallbackQuery('@F1/edge/x')).toBeNull()  // non-numeric idx
    expect(parseTopoFallbackQuery('@F1/blob/3')).toBeNull()  // unknown kind
  })
})

describe('emitAbsoluteSelectionQuery', () => {
  it('always emits the absolute (@) form for an entity selection', () => {
    expect(emitAbsoluteSelectionQuery('entity:F1:L1')).toBe('@F1L1')
  })

  it('emits the absolute form with the vertex sub for a vertex selection', () => {
    expect(emitAbsoluteSelectionQuery('vertex:F1:L1:end')).toBe('@F1L1end')
  })

  it('passes a face inner query through verbatim', () => {
    expect(emitAbsoluteSelectionQuery('face:F1:@F1/face/0')).toBe('@F1/face/0')
  })

  it('passes a non-prefixed query (e.g. an ancestry string) through unchanged', () => {
    expect(emitAbsoluteSelectionQuery('?2;ab')).toBe('?2;ab')
  })
})
