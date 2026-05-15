import { describe, it, expect } from 'vitest'
import { emitWire, parseQuery, q } from '@/utils/query'

describe('emitWire', () => {
  it('local no sub',       () => expect(emitWire(q.local('e1'))).toBe('$e1'))
  it('local with start',   () => expect(emitWire(q.local('e1', 'start'))).toBe('$e1start'))
  it('local with end',     () => expect(emitWire(q.local('e1', 'end'))).toBe('$e1end'))
  it('absolute feature',   () => expect(emitWire(q.absolute('sk1'))).toBe('@sk1'))
  it('absolute element',   () => expect(emitWire(q.absolute('sk1', 'l1'))).toBe('@sk1l1'))
  it('absolute with sub',  () => expect(emitWire(q.absolute('sk1', 'l1', 'end'))).toBe('@sk1l1end'))
  it('ancestry two ids', () => {
    const s = emitWire(q.ancestry(['@sk1a', '@sk1b']))
    expect(s).toMatch(/^\?/)
    expect(s).toContain('@sk1a')
    expect(s).toContain('@sk1b')
  })
  it('ancestry with type',       () => expect(emitWire(q.ancestry(['@a'], 'flatface'))).toContain(':flatface'))
  it('ancestry with classifier', () => expect(emitWire(q.ancestry(['@a'], 'flatface', 'inner'))).toContain('@inner'))
})

describe('parseQuery', () => {
  it('dispatches local',    () => expect(parseQuery('$e1').kind).toBe('local'))
  it('dispatches absolute', () => expect(parseQuery('@sk1l1').kind).toBe('absolute'))
  it('dispatches ancestry', () => expect(parseQuery('?6;@sk1l1').kind).toBe('ancestry'))
  it('throws on empty',     () => expect(() => parseQuery('')).toThrow())
  it('throws on unknown',   () => expect(() => parseQuery('!bad')).toThrow())
})

describe('parseQuery round-trips via emitWire', () => {
  const cases = [
    '$line1', '$line1start', '$line1end', '$line1center', '$line1xy',
    '@sketch1', '@sketch1line1', '@sketch1line1start',
    '?d,c;@sketch1line1@sketch1arc1',
    '?d,c;@sketch1line1@sketch1arc1:flatface',
    '?d,c;@sketch1line1@sketch1arc1:flatface@inner',
  ]
  cases.forEach(s => {
    it(`round-trips "${s}"`, () => expect(emitWire(parseQuery(s))).toBe(s))
  })
})

describe('q helpers produce correct emitWire output', () => {
  it('q.local',    () => expect(emitWire(q.local('e1', 'start'))).toBe('$e1start'))
  it('q.absolute', () => expect(emitWire(q.absolute('sk1', 'l1', 'end'))).toBe('@sk1l1end'))
  it('q.ancestry accepts Query objects -- emitWire is called internally, not by caller', () => {
    const a = q.absolute('sk1', 'l1')
    const b = q.absolute('sk1', 'arc1')
    const anc = q.ancestry([a, b], 'flatface')
    expect(anc.ids).toEqual(['@sk1l1', '@sk1arc1'])
  })
})
