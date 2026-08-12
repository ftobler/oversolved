import { describe, it, expect } from 'vitest'
import { emitWire, parseQuery } from '@/utils/query'

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
    '$ell1major1', '$ell1major2', '$ell1minor1', '$ell1minor2',
    '@sketch1', '@sketch1line1', '@sketch1line1start',
    '?d,c;@sketch1line1@sketch1arc1',
    '?d,c;@sketch1line1@sketch1arc1:flatface',
    '?d,c;@sketch1line1@sketch1arc1:flatface@inner',
  ]
  cases.forEach(s => {
    it(`round-trips "${s}"`, () => expect(emitWire(parseQuery(s))).toBe(s))
  })
})

describe('emitWire handles all query shapes', () => {
  it('local',    () => expect(emitWire({ kind: 'local', eid: 'e1', sub: 'start' })).toBe('$e1start'))
  // The kernel's slash-joined absolute (canonical) separates featureId, eid
  // and sub with "/" instead of concatenating them.
  it('absolute', () => expect(emitWire({ kind: 'absolute', featureId: 'sk1', eid: 'l1', sub: 'end' })).toBe('@sk1/l1/end'))
  it('ancestry with string ids', () => {
    const anc = {
      kind: 'ancestry' as const,
      ancestorIds: ['@sk1l1', '@sk1arc1'],
      typeRestriction: 'flatface' as string | null,
      classifier: undefined as string | null | undefined,
    }
    expect(emitWire(anc)).toContain('@sk1l1')
    expect(emitWire(anc)).toContain('@sk1arc1')
  })
})
