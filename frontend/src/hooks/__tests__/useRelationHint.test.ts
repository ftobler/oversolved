// The part hint derivation caches on the store's own references: a re-render
// that changes neither the selection nor the solve keeps one hints object, so
// per-body memo dependencies stay stable.

import { describe, it, expect } from 'vitest'
import type { BodyResult, PartFeature } from '@/types/cad'
import { makeAncestryQuery } from '@/kernel/query'
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

const pickOne = makeAncestryQuery(['@u|one', '@fi1', '@body_ex1'], 'straightedge')
const pickTwo = makeAncestryQuery(['@u|two', '@fi1', '@body_ex1'], 'straightedge')
const fi1: PartFeature = { id: 'fi1', kind: 'fillet', fillet: { edges: [pickOne, pickTwo], radius: 20 } }
const filletFeatures = [ex1, fi1]
const filletBodies: Record<string, BodyResult> = {
  body_ex1: {
    id: 'body_ex1', created_by: 'ex1', modified_by: [],
    edges: [], edge_queries: [pickOne, pickTwo],
  },
}

describe('partRelationHintsFor: the open editor', () => {
  it('hints the edited feature\'s picks without tinting the faces it created', () => {
    // The row is not selected (a double-click selects then deselects), so the
    // open editor is the only driver. Its picks show; its output does not tint.
    const hints = partRelationHintsFor(new Set(), filletFeatures, filletBodies, null, 'fi1')
    expect(hints.picked).toEqual(new Set([pickOne, pickTwo]))
    expect(hints.viewport.size).toBe(0)
    expect(hints.tree.size).toBe(0)
  })

  it('the failed set splits the refused pick into the failure colour', () => {
    const hints = partRelationHintsFor(
      new Set(), filletFeatures, filletBodies, null, 'fi1', new Set([pickTwo]),
    )
    expect(hints.picked).toEqual(new Set([pickOne]))
    expect(hints.failedPicks).toEqual(new Set([pickTwo]))
  })

  it('recomputes when the focus or the failed set changes', () => {
    const base = partRelationHintsFor(new Set(), filletFeatures, filletBodies, null)
    const focused = partRelationHintsFor(new Set(), filletFeatures, filletBodies, null, 'fi1')
    const failed = partRelationHintsFor(new Set(), filletFeatures, filletBodies, null, 'fi1', new Set([pickTwo]))
    expect(focused).not.toBe(base)
    expect(failed).not.toBe(focused)
  })
})
