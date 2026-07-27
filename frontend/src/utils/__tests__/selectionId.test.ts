import { describe, it, expect } from 'vitest'
import { sel, selectionKey, parseSelectionId, selectionToQuery, emitAbsoluteSelectionQuery, parseTopoFallbackQuery, topoFallbackQuery } from '@/utils/query/selectionId'
import { emitWire } from '@/utils/query'
import type { LocalQuery, AbsoluteQuery } from '@/types/query'

describe('selectionKey', () => {
  it('entity',     () => expect(selectionKey(sel.entity('sk1', 'l1'))).toBe('entity:sk1:l1'))
  it('vertex',     () => expect(selectionKey(sel.vertex('sk1', 'l1', 'start'))).toBe('vertex:sk1:l1:start'))
  it('face',       () => expect(selectionKey(sel.face('sk1', '?c;@a'))).toBe('face:sk1:?c;@a'))
  it('edge',       () => expect(selectionKey(sel.edge('sk1', '?c;@a'))).toBe('edge:sk1:?c;@a'))
  it('plane',      () => expect(selectionKey(sel.plane('sk1'))).toBe('@sk1'))
  it('constraint', () => expect(selectionKey(sel.constraint('sk1', 'c1'))).toBe('constraint:sk1:c1'))
})

describe('parseSelectionId', () => {
  it('entity',     () => expect(parseSelectionId('entity:sk1:l1')).toEqual(sel.entity('sk1', 'l1')))
  it('vertex',     () => expect(parseSelectionId('vertex:sk1:l1:start')).toEqual(sel.vertex('sk1', 'l1', 'start')))
  it('face passthrough', () => {
    const raw = '?c,c;@sk1line1@sk1arc1:flatface'
    expect(parseSelectionId(`face:sk1:${raw}`)).toEqual(sel.face('sk1', raw))
  })
  it('plane @ref',    () => expect(parseSelectionId('@sk1')).toEqual({ kind: 'plane', featureId: 'sk1' }))
  it('builtin plane', () => expect(parseSelectionId('@builtin_plane_front')).toEqual({ kind: 'plane', featureId: 'builtin_plane_front' }))
  it('throws on unknown', () => expect(() => parseSelectionId('unknown:x')).toThrow())
})

describe('parseSelectionId round-trips via selectionKey', () => {
  const cases = [
    'entity:sk1:l1',
    'vertex:sk1:l1:start',
    'vertex:sk1:arc1:center',
    'face:sk1:?6,6;@sk1l1@sk1a1:flatface',
    'edge:sk1:?6;@sk1l1',
    'constraint:sk1:c_coincident_abc',
    '@sk1',
    '@builtin_plane_front',
  ]
  cases.forEach(s => {
    it(`round-trips "${s}"`, () => expect(selectionKey(parseSelectionId(s))).toBe(s))
  })
})

describe('selectionToQuery', () => {
  const HOST = 'sketch1'

  describe('entity selection', () => {
    it('same-feature -> local query',
      () => expect(selectionToQuery(sel.entity(HOST, 'l1'), HOST).kind).toBe('local'))
    it('same-feature -> local eid correct',
      () => expect((selectionToQuery(sel.entity(HOST, 'l1'), HOST) as LocalQuery).eid).toBe('l1'))
    it('cross-feature -> absolute query',
      () => expect(selectionToQuery(sel.entity('sketch2', 'l1'), HOST).kind).toBe('absolute'))
    it('cross-feature -> absolute featureId correct',
      () => expect((selectionToQuery(sel.entity('sketch2', 'l1'), HOST) as AbsoluteQuery).featureId).toBe('sketch2'))
  })

  describe('vertex selection', () => {
    it('same-feature with sub -> local with sub', () => {
      const r = selectionToQuery(sel.vertex(HOST, 'l1', 'start'), HOST) as LocalQuery
      expect(r.kind).toBe('local')
      expect(r.sub).toBe('start')
    })
    it('cross-feature with sub -> absolute with sub', () => {
      const r = selectionToQuery(sel.vertex('sketch2', 'l1', 'end'), HOST) as AbsoluteQuery
      expect(r.kind).toBe('absolute')
      expect(r.sub).toBe('end')
    })
  })

  describe('face/edge selection', () => {
    it('face -> ancestry query kind',
      () => expect(selectionToQuery(sel.face(HOST, '?a;@sketch1l1'), HOST).kind).toBe('ancestry'))
    it('edge -> ancestry query kind',
      () => expect(selectionToQuery(sel.edge(HOST, '?a;@sketch1l1'), HOST).kind).toBe('ancestry'))
    it('face emitWire round-trips the raw ancestry string', () => {
      const raw = '?a,c;@sketch1l1@sketch1arc1:flatface'
      expect(emitWire(selectionToQuery(sel.face(HOST, raw), HOST))).toBe(raw)
    })
  })

  describe('plane selection', () => {
    it('plane -> absolute query with no eid', () => {
      const r = selectionToQuery(sel.plane('sketch2'), HOST) as AbsoluteQuery
      expect(r.kind).toBe('absolute')
      expect(r.eid).toBeFalsy()
    })
    it('builtin plane -> featureId preserved',
      () => expect((selectionToQuery(sel.plane('builtin_plane_front'), HOST) as AbsoluteQuery).featureId).toBe('builtin_plane_front'))
  })

  describe('constraint selection', () => {
    it('throws', () => expect(() => selectionToQuery(sel.constraint(HOST, 'c1'), HOST)).toThrow())
  })

  describe('parity with old parseTarget (via emitWire)', () => {
    const cases: Array<[string, string, string]> = [
      ['entity:sketch1:line1',       'sketch1', '$line1'],
      ['entity:sketch2:line1',       'sketch1', '@sketch2line1'],
      ['vertex:sketch1:line1:start', 'sketch1', '$line1start'],
      ['vertex:sketch2:arc1:center', 'sketch1', '@sketch2arc1center'],
      ['@builtin_plane_front',       'sketch1', '@builtin_plane_front'],
    ]
    cases.forEach(([raw, host, expected]) => {
      it(`"${raw}" with host "${host}" -> "${expected}"`, () => {
        const parsed = parseSelectionId(raw)
        expect(emitWire(selectionToQuery(parsed, host))).toBe(expected)
      })
    })
  })
})

describe('emitAbsoluteSelectionQuery', () => {
  it('face passthrough — strips prefix', () => {
    expect(emitAbsoluteSelectionQuery('face:ex1:?9;@ex1face0:face')).toBe('?9;@ex1face0:face')
  })
  it('entity always absolute (cross-feature)', () => {
    expect(emitAbsoluteSelectionQuery('entity:S1:L1')).toBe('@S1L1')
  })
  it('entity always absolute even if host would match', () => {
    // Host concept is absent — must never emit $ form.
    expect(emitAbsoluteSelectionQuery('entity:sk1:L1')).toBe('@sk1L1')
  })
  it('vertex always absolute with sub', () => {
    expect(emitAbsoluteSelectionQuery('vertex:S1:L1:start')).toBe('@S1L1start')
  })
  it('plane @ ref pass through', () => {
    expect(emitAbsoluteSelectionQuery('@builtin_plane_front')).toBe('@builtin_plane_front')
  })
  it('edge pass through (verbatim)', () => {
    expect(emitAbsoluteSelectionQuery('edge:ex1:?9;@ex1edge0:edge')).toBe('edge:ex1:?9;@ex1edge0:edge')
  })
  it('unknown pass through', () => {
    expect(emitAbsoluteSelectionQuery('someRawString')).toBe('someRawString')
  })
  it('body: pass through', () => {
    expect(emitAbsoluteSelectionQuery('body:body_ex1')).toBe('body:body_ex1')
  })

  describe('byte parity with old PlaneEditor inline code', () => {
    const cases: Array<[string, string]> = [
      ['face:ex1:?9;@ex1face0:face', '?9;@ex1face0:face'],
      ['vertex:S1:L1:start', '@S1L1start'],
      ['vertex:sketch2:arc1:center', '@sketch2arc1center'],
      ['entity:S1:L1', '@S1L1'],
      ['entity:sketch2:A1', '@sketch2A1'],
      ['@builtin_plane_front', '@builtin_plane_front'],
      ['edge:ex1:?9;@ex1edge0:edge', 'edge:ex1:?9;@ex1edge0:edge'],
      ['body:body_ex1', 'body:body_ex1'],
    ]
    cases.forEach(([input, expected]) => {
      it(`"${input}" -> "${expected}"`, () => {
        expect(emitAbsoluteSelectionQuery(input)).toBe(expected)
      })
    })
  })
})

describe('parseTopoFallbackQuery', () => {
  it('parses edge query', () => {
    expect(parseTopoFallbackQuery('@body_ex1/edge/0')).toEqual({ bodyId: 'body_ex1', kind: 'edge', idx: 0 })
  })
  it('parses face query', () => {
    expect(parseTopoFallbackQuery('@body1/face/3')).toEqual({ bodyId: 'body1', kind: 'face', idx: 3 })
  })
  it('parses vertex query', () => {
    expect(parseTopoFallbackQuery('@sk1/vertex/7')).toEqual({ bodyId: 'sk1', kind: 'vertex', idx: 7 })
  })
  it('multi-digit index', () => {
    expect(parseTopoFallbackQuery('@ex1/edge/123')).toEqual({ bodyId: 'ex1', kind: 'edge', idx: 123 })
  })
  // The leading token is a body id, and split siblings carry an `_N` suffix that
  // must survive the round trip -- it is the only thing separating two siblings.
  it('keeps a split sibling id whole', () => {
    expect(parseTopoFallbackQuery('@body_ex1_1/edge/0')).toEqual({ bodyId: 'body_ex1_1', kind: 'edge', idx: 0 })
  })
  it('non-numeric idx returns null', () => {
    expect(parseTopoFallbackQuery('@ex1/edge/abc')).toBeNull()
  })
  it('unknown kind returns null', () => {
    expect(parseTopoFallbackQuery('@ex1/body/0')).toBeNull()
  })
  it('single slash returns null', () => {
    expect(parseTopoFallbackQuery('@ex1/edge')).toBeNull()
  })
  it('no at sign returns null', () => {
    expect(parseTopoFallbackQuery('ex1/edge/0')).toBeNull()
  })
  it('ancestry query returns null', () => {
    expect(parseTopoFallbackQuery('?9;@ex1edge0:edge')).toBeNull()
  })
  it('plane ref returns null', () => {
    expect(parseTopoFallbackQuery('@builtin_plane_front')).toBeNull()
  })

  describe('round-trip with topoFallbackQuery', () => {
    const cases: Array<{ bodyId: string; kind: 'edge' | 'face' | 'vertex'; idx: number }> = [
      { bodyId: 'body_ex1', kind: 'edge', idx: 0 },
      { bodyId: 'body_ex1_1', kind: 'edge', idx: 0 },
      { bodyId: 'body1', kind: 'face', idx: 5 },
      { bodyId: 'sk1', kind: 'vertex', idx: 99 },
    ]
    cases.forEach(({ bodyId, kind, idx }) => {
      it(`${bodyId} ${kind}/${idx}`, () => {
        const serialized = topoFallbackQuery(bodyId, kind, idx)
        const parsed = parseTopoFallbackQuery(serialized)
        expect(parsed).toEqual({ bodyId, kind, idx })
      })
    })
  })
})
