// Cross-module guard: the `?/@/$` wire format must be byte-identical between
// the kernel serializer (kernel/query.ts) and the app-facing re-export
// (utils/query). The two used to be independent implementations that drifted
// apart; utils/query now re-exports the kernel's emitWire/parseQuery. This test
// pins that the two module surfaces agree on a representative corpus (every
// kind x sub-suffix x classifier combo) so they cannot diverge again.
import { describe, it, expect } from 'vitest'
import { emitWire as utilsEmit, parseQuery as utilsParse } from '@/utils/query'
import { emitWire as kernelEmit, parseQuery as kernelParse } from '@/kernel/query'
import type { Query } from '@/types/query'

// ─── byte-level corpus: every kind x sub-suffix x classifier combo ───

const LOCAL_SUBS = ['', 'start', 'end', 'center', 'xy', 'major1', 'major2', 'minor1', 'minor2', 'c1', 'c2']

const CORPUS: Query[] = [
  // local, every sub suffix (wider set must round-trip in both)
  ...LOCAL_SUBS.map(sub => ({ kind: 'local' as const, eid: 'e3', sub })),
  // absolute: bare feature, feature/eid, feature/eid/sub (slash-joined)
  { kind: 'absolute', featureId: 'sk1' },
  { kind: 'absolute', featureId: 'sk1', eid: 'l1' },
  { kind: 'absolute', featureId: 'sk1', eid: 'l1', sub: 'start' },
  // ancestry: no type, type only, classifier only, type + classifier
  { kind: 'ancestry', ancestorIds: ['@a', '@b'], typeRestriction: null },
  { kind: 'ancestry', ancestorIds: ['@a', '@b'], typeRestriction: 'flatface' },
  { kind: 'ancestry', ancestorIds: ['@a', '@b'], typeRestriction: null, classifier: 'inner' },
  { kind: 'ancestry', ancestorIds: ['@a', '@b'], typeRestriction: 'flatface', classifier: 'inner' },
  // length-framed ids must survive a non-trivial byte length
  { kind: 'ancestry', ancestorIds: ['@sketch1line1', '@sketch1arc1'], typeRestriction: 'flatface' },
]

const WIRE: string[] = [
  '$e3', '$e3start', '$e3end', '$e3center', '$e3xy',
  '$e3major1', '$e3major2', '$e3minor1', '$e3minor2', '$e3c1', '$e3c2',
  '@sk1', '@sk1/l1', '@sk1/l1/start',
  '?2,2;@a@b',
  '?2,2;@a@b:flatface',
  '?2,2;@a@b@inner',
  '?2,2;@a@b:flatface@inner',
  '?d,c;@sketch1line1@sketch1arc1:flatface',
]

describe('kernel/query and utils/query emit byte-identical wire', () => {
  it('every corpus query emits the same string from both module surfaces', () => {
    CORPUS.forEach((q, i) => {
      const kernel = kernelEmit(q)
      expect(utilsEmit(q)).toBe(kernel)
      expect(kernel).toBe(WIRE[i])
    })
  })

  it('every wire string parses structurally identical through both parsers', () => {
    WIRE.forEach(s => {
      expect(utilsParse(s)).toEqual(kernelParse(s))
    })
  })

  it('parse then emit round-trips byte-identically', () => {
    for (const s of WIRE) {
      expect(utilsEmit(utilsParse(s))).toBe(s)
      expect(kernelEmit(kernelParse(s))).toBe(s)
    }
  })
})

// ─── the real persisted target that exposed the divergent local suffix set ───

describe('real persisted local sub-suffix', () => {
  it('$pwfYD59xKWiSyQhmcenter parses to sub=center in both modules', () => {
    const utils = utilsParse('$pwfYD59xKWiSyQhmcenter')
    const kernel = kernelParse('$pwfYD59xKWiSyQhmcenter')
    expect(utils).toEqual({ kind: 'local', eid: 'pwfYD59xKWiSyQhm', sub: 'center' })
    expect(kernel).toEqual(utils)
  })
})

// ─── classifier is a first-class field, not swallowed into typeRestriction ───

describe('ancestry classifier suffix', () => {
  const s = '?2,2;@a@b:flatface@inner'

  it('parses to typeRestriction=flatface + classifier=inner in both modules', () => {
    const utils = utilsParse(s)
    const kernel = kernelParse(s)
    expect(utils).toEqual({
      kind: 'ancestry', ancestorIds: ['@a', '@b'],
      typeRestriction: 'flatface', classifier: 'inner',
    })
    expect(kernel).toEqual(utils)
  })

  it('round-trips the classifier through both parsers', () => {
    expect(utilsEmit(utilsParse(s))).toBe(s)
    expect(kernelEmit(kernelParse(s))).toBe(s)
  })
})

// ─── persisted-doc compatibility: old concatenated @feat+eid strings ───

describe('legacy concatenated absolute (old utils encoder)', () => {
  // The pre-single-source utils encoder emitted `@feat+eid` with no separator.
  // Both parsers must agree on how that string reads back: the whole tail is
  // the featureId (no slash to split on), and it round-trips byte-identically.
  it('parses to featureId=whole in both modules and round-trips', () => {
    const legacy = '@sketch2line1'
    const utils = utilsParse(legacy)
    const kernel = kernelParse(legacy)
    expect(utils).toEqual({ kind: 'absolute', featureId: 'sketch2line1', eid: '', sub: '' })
    expect(kernel).toEqual(utils)
    expect(utilsEmit(utils)).toBe(legacy)
    expect(kernelEmit(kernel)).toBe(legacy)
  })
})
