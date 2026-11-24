// A reorder may not put a projection's consumer sketch at or before the sketch
// it projects from: the solve reads sources in feature order, so the move would
// turn a working row into a permanent forward reference. Both directions are
// the same rule, and a move that no projection cares about stays free.
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { applyReorderFeatures, applyMoveFeatureBefore } from '@/utils/yamlMutations/featureAdmin'

function doc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [
      { id: 'Origin', kind: 'origin' },
      { id: 'Top', kind: 'plane' },
      { id: 'Front', kind: 'plane' },
      { id: 'Right', kind: 'plane' },
      {
        id: 'sk1', kind: 'sketch', plane: '@builtin_plane_top',
        entities: [{ id: 'l1', kind: 'line' }],
        initial: { l1: [0, 0, 10, 0] },
      },
      {
        id: 'sk2', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [{ id: 'p1', kind: 'point' }],
        initial: { p1: [1, 1] },
        constraints: [{ id: 'proj_p1', kind: 'projection', target: '$p1', source: '@sk1/l1' }],
      },
      { id: 'sk3', kind: 'sketch', plane: '@builtin_plane_right' },
    ],
  }
}

const ids = (d: PartDoc) => (d.features ?? []).map(feature => feature.id)

describe('applyReorderFeatures refuses a projection forward reference', () => {
  it('refuses moving a source sketch below its consumer', () => {
    const d = doc()
    const before = structuredClone(d)
    // sk1 currently sits directly above sk2. Dropping it below sk2 (index 6)
    // would make sk2 project a later sketch.
    expect(() => applyReorderFeatures(d, 'sk1', 6)).toThrow(
      'cannot move sketch 1 below sketch 2: sketch 2 projects line 1 (a sketch can only project earlier sketches)',
    )
    expect(d).toEqual(before)
  })

  it('refuses moving a consumer sketch above its source', () => {
    const d = doc()
    const before = structuredClone(d)
    // Dropping sk2 above sk1 (index 4 is sk1's own slot) inverts the pair.
    expect(() => applyReorderFeatures(d, 'sk2', 4)).toThrow(
      'cannot move sketch 2 above sketch 1: sketch 2 projects line 1 (a sketch can only project earlier sketches)',
    )
    expect(d).toEqual(before)
  })

  it('inherits the check through applyMoveFeatureBefore', () => {
    const d = doc()
    const before = structuredClone(d)
    expect(() => applyMoveFeatureBefore(d, 'sk1', 'sk3')).toThrow(/cannot move sketch 1 below sketch 2/)
    expect(d).toEqual(before)
  })

  it('allows moving a feature no sketch projects', () => {
    const d = doc()
    applyReorderFeatures(d, 'sk3', 4)
    expect(ids(d).indexOf('sk3')).toBe(4)
  })

  it('leaves an unrelated move free even when the stored doc is already invalid', () => {
    const d = doc()
    const sk2 = d.features!.find(feature => feature.id === 'sk2')
    if (sk2?.kind !== 'sketch') throw new Error('not a sketch')
    sk2.constraints = [{ id: 'proj_p1', kind: 'projection', target: '$p1', source: '@sk3/q3' }]
    applyReorderFeatures(d, 'sk3', 4)
    expect(ids(d).indexOf('sk3')).toBe(4)
  })
})
