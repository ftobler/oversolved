import { describe, it, expect } from 'vitest'
import { relatedMateIds, relatedPartHandles } from '@/utils/assemblyTreeHighlight'
import type { MateFeature } from '@/types/cad'

function mate(id: string, partA: string, partB: string): MateFeature {
  return {
    id,
    mate: {
      kind: 'fixed',
      ref_a: { part: partA, anchor: 'a1' },
      ref_b: { part: partB, anchor: 'b1' },
    },
  }
}

const mates: MateFeature[] = [
  mate('m1', 'p1', 'p2'),
  mate('m2', 'p2', 'p3'),
  mate('m3', 'p1', 'p1'),  // self-mate
]

describe('relatedMateIds', () => {
  it('collects every mate whose ref_a or ref_b names the part', () => {
    expect(relatedMateIds(mates, 'p1')).toEqual(new Set(['m1', 'm3']))
  })

  it('a part shared by two mates yields both ids', () => {
    expect(relatedMateIds(mates, 'p2')).toEqual(new Set(['m1', 'm2']))
  })

  it('returns an empty set for a part with no mates', () => {
    expect(relatedMateIds(mates, 'p9')).toEqual(new Set())
  })

  it('returns an empty set when nothing is selected', () => {
    expect(relatedMateIds(mates, null)).toEqual(new Set())
    expect(relatedMateIds(mates, undefined)).toEqual(new Set())
  })
})

describe('relatedPartHandles', () => {
  it('collects both part handles the mate references', () => {
    expect(relatedPartHandles(mates, 'm1')).toEqual(new Set(['p1', 'p2']))
  })

  it('a self-mate yields a single-entry set, not two rows', () => {
    expect(relatedPartHandles(mates, 'm3')).toEqual(new Set(['p1']))
  })

  it('returns an empty set when nothing is selected', () => {
    expect(relatedPartHandles(mates, null)).toEqual(new Set())
    expect(relatedPartHandles(mates, undefined)).toEqual(new Set())
  })

  it('returns an empty set for a mate id that does not exist', () => {
    expect(relatedPartHandles(mates, 'does-not-exist')).toEqual(new Set())
  })

  it('still returns a handle that no longer resolves to an instance', () => {
    // The function only knows mates, not the current part list: a stale ref
    // (part deleted, mate not yet cleaned up) still yields its handle. The
    // tree only lights up a row that actually exists, so this is harmless.
    const withGhostRef: MateFeature[] = [mate('m4', 'p1', 'ghost')]
    expect(relatedPartHandles(withGhostRef, 'm4')).toEqual(new Set(['p1', 'ghost']))
  })
})
