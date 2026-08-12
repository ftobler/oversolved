// Cross-module guard: the `?/@/$` wire format must be byte-identical between
// the kernel serializer (kernel/query.ts) and the app-facing re-export
// (utils/query). The two used to be independent implementations that drifted
// apart; utils/query now re-exports the kernel's emitWire/parseQuery. This test
// pins that the two module surfaces agree on a representative corpus (every
// kind x sub-suffix x classifier combo) so they cannot diverge again.
import { describe, it, expect, vi } from 'vitest'
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
  // wire-format-hardening: the ...1xy sub-point (eid ending in a suffix word
  // is expressible as a SUB; a bare id on the split side emits verbatim and the
  // knownIds readers resolve it, so it never throws)
  { kind: 'local', eid: 'a1', sub: 'xy' },
  // minted base64url bare id ending in a pure-word suffix: deterministic kernel
  // reading is eid+sub, contextual readers resolve the whole id
  { kind: 'local', eid: 'k-g9YNviFC85Z-7K', sub: 'xy' },
  // empty id list: "?0;" is the parseable canonical empty form
  { kind: 'ancestry', ancestorIds: [], typeRestriction: null },
  // empty type restriction is null on the wire: no trailing ':'
  { kind: 'ancestry', ancestorIds: ['@a'], typeRestriction: '' },
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
  '$a1xy',
  '$k-g9YNviFC85Z-7Kxy',
  '?0;',
  '?2;@a',
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

// ─── wire-format-hardening: strict edges stay byte-equal across both surfaces ───

describe('hardened grammar stays byte-equal across both surfaces', () => {
  it('accepts "?2;@a:" and both surfaces canonicalize it to "?2;@a"', () => {
    expect(utilsEmit(utilsParse('?2;@a:'))).toBe('?2;@a')
    expect(kernelEmit(kernelParse('?2;@a:'))).toBe('?2;@a')
  })

  it('rejects zero-length segments, trailing garbage and >3-part absolute identically', () => {
    for (const bad of ['?0;abc', '?0,2;@a', '?3;abcdef', '@a/b/c/d', '@a//c', '@a/b/']) {
      let utilsThrew = false
      let kernelThrew = false
      try { utilsParse(bad) } catch { utilsThrew = true }
      try { kernelParse(bad) } catch { kernelThrew = true }
      expect(utilsThrew).toBe(true)
      expect(kernelThrew).toBe(true)
    }
  })

  it('the ...1xy parse decision is identical: sub-point in both, bare id emits verbatim in both', () => {
    expect(utilsParse('$a1xy')).toEqual({ kind: 'local', eid: 'a1', sub: 'xy' })
    expect(kernelParse('$a1xy')).toEqual(utilsParse('$a1xy'))
    expect(utilsParse('$arc1')).toEqual({ kind: 'local', eid: 'arc1', sub: '' })
    expect(kernelParse('$arc1')).toEqual(utilsParse('$arc1'))
    // A bare id on the split side never throws (minted ids can land there);
    // it emits verbatim and the knownIds readers resolve it by full-id
    // membership. The deterministic kernel reading is the eid+sub split. The
    // dev/test warn is expected here, so spy it out to keep the output clean.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(utilsEmit({ kind: 'local', eid: 'a1xy' })).toBe('$a1xy')
      expect(kernelEmit({ kind: 'local', eid: 'a1xy' })).toBe('$a1xy')
    } finally {
      warnSpy.mockRestore()
    }
  })
})
