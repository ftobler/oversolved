import { describe, it, expect } from 'vitest'
import { sel, selectionKey, parseSelectionId, selectionToQuery } from '@/utils/selectionId'
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
