// The part hint derivation caches on the store's own references: a re-render
// that changes neither the selection nor the solve keeps one hints object, so
// per-body memo dependencies stay stable.

import { describe, it, expect } from 'vitest'
import type { PartFeature } from '@/types/cad'
import { partRelationHintsFor } from '@/hooks/useRelationHint'

const sk1: PartFeature = { id: 'sk1', kind: 'sketch' }
const ex1: PartFeature = {
  id: 'ex1',
  kind: 'extrude',
  extrude: { sketch: '@sk1', distance: 10 },
}
const features = [sk1, ex1]
const bodies = {}

describe('partRelationHintsFor', () => {
  it('returns the same hints object for the same input references', () => {
    const selection = new Set(['@ex1'])
    const first = partRelationHintsFor(selection, features, bodies, null)
    const second = partRelationHintsFor(selection, features, bodies, null)
    expect(second).toBe(first)
    expect(first.tree).toEqual(new Set(['@sk1']))
    expect(first.viewport).toEqual(new Set(['ex1', 'sk1']))
  })

  it('recomputes when the selection changes', () => {
    const first = partRelationHintsFor(new Set(['@ex1']), features, bodies, null)
    const second = partRelationHintsFor(new Set(['@sk1']), features, bodies, null)
    expect(second).not.toBe(first)
    expect(second.tree).toEqual(new Set(['@ex1']))
  })

  it('recomputes when the rollback window changes', () => {
    const selection = new Set(['@ex1'])
    const first = partRelationHintsFor(selection, features, bodies, null)
    const second = partRelationHintsFor(selection, features, bodies, 1)
    expect(second).not.toBe(first)
    expect(second.viewport.size).toBe(0)
  })
})
