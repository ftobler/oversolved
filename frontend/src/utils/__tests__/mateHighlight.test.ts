// Selecting a mate in the tree must highlight exactly the entities its refs
// resolve to, through the same entityMateRefs reverse-lookup the pick chip
// uses. No viewport, no store: a mate def and the lookup in, a key set out.

import { describe, it, expect } from 'vitest'
import { entityKeysForMate } from '@/utils/mateHighlight'
import type { EntityMateRefs } from '@/utils/anchorCandidates'
import type { MateFeatureDef } from '@/types/cad'

const PART_A = 'inst_a'
const PART_B = 'inst_b'

function mate(overrides: Partial<MateFeatureDef> = {}): MateFeatureDef {
  return {
    kind: 'fixed',
    ref_a: { part: PART_A, anchor: 'a_top' },
    ref_b: { part: PART_B, anchor: 'b_bottom' },
    ...overrides,
  }
}

describe('entityKeysForMate', () => {
  it('resolves both refs to their entity keys', () => {
    const refs: EntityMateRefs = {
      'A|0|face|0': [{ part: PART_A, anchor: 'a_top' }],
      'B|0|face|1': [{ part: PART_B, anchor: 'b_bottom' }],
      'B|0|face|2': [{ part: PART_B, anchor: 'unrelated' }],
    }
    const keys = entityKeysForMate(mate(), refs)
    expect(keys).toEqual(new Set(['A|0|face|0', 'B|0|face|1']))
  })

  it('a ref naming an anchor no entity offers contributes nothing', () => {
    const refs: EntityMateRefs = {
      'A|0|face|0': [{ part: PART_A, anchor: 'a_top' }],
    }
    // ref_b names an anchor the current bundle no longer has (stale mate).
    const keys = entityKeysForMate(mate({ ref_b: { part: PART_B, anchor: 'gone' } }), refs)
    expect(keys).toEqual(new Set(['A|0|face|0']))
  })

  it('a ref shared by several entities highlights all of them', () => {
    const refs: EntityMateRefs = {
      'A|0|vertex|0': [{ part: PART_A, anchor: 'a_top' }],
      'A|0|edge|0': [{ part: PART_A, anchor: 'a_top' }],
      'A|0|face|0': [{ part: PART_A, anchor: 'a_top' }],
      'B|0|face|1': [{ part: PART_B, anchor: 'b_bottom' }],
    }
    const keys = entityKeysForMate(mate(), refs)
    expect(keys).toEqual(new Set(['A|0|vertex|0', 'A|0|edge|0', 'A|0|face|0', 'B|0|face|1']))
  })

  it('returns an empty set when no mate is selected', () => {
    const refs: EntityMateRefs = {
      'A|0|face|0': [{ part: PART_A, anchor: 'a_top' }],
    }
    expect(entityKeysForMate(undefined, refs)).toEqual(new Set())
  })

  it('returns an empty set when neither ref resolves', () => {
    const refs: EntityMateRefs = {
      'A|0|face|0': [{ part: PART_A, anchor: 'other' }],
    }
    expect(entityKeysForMate(mate(), refs)).toEqual(new Set())
  })

  it('returns the same empty-set instance across calls with nothing to highlight', () => {
    // A caller memoizes its own useMemo on this return value; a fresh Set
    // every call would defeat that even though there is nothing new to draw.
    const refsA: EntityMateRefs = { 'A|0|face|0': [{ part: PART_A, anchor: 'other' }] }
    const refsB: EntityMateRefs = { 'B|0|face|0': [{ part: PART_B, anchor: 'other-still' }] }
    const noMate = entityKeysForMate(undefined, refsA)
    const staleMate = entityKeysForMate(mate(), refsB)
    expect(noMate).toBe(staleMate)
  })
})
