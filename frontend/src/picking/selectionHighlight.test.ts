import { describe, it, expect } from 'vitest'
import { computePrimitiveSelection } from './selectionHighlight'
import { primitivePickKey } from './pickKey'

const BODY = 'extrude1/body0'
const LAYER = 'edge'
const pk = (i: number) => primitivePickKey(BODY, i, LAYER)

describe('computePrimitiveSelection', () => {
  it('isolates the single live pick when two primitives share a query', () => {
    // Edges 0 and 1 collide on query "Q"; edge 2 is unique. The user clicked
    // edge 0, so only edge 0 highlights -- the grouping is gone.
    const queries = ['Q', 'Q', 'R']
    const normal = new Set(['Q'])
    const picks = new Set([pk(0)])
    expect(computePrimitiveSelection(BODY, queries, normal, picks, LAYER)).toEqual([true, false, false])
  })

  it('falls back to query membership for a persisted pick with no live pickKey', () => {
    // After a re-solve the pickKey is gone; the stored query re-highlights. A
    // unique query hits exactly one primitive.
    const queries = ['Q', 'R', 'S']
    const normal = new Set(['R'])
    const picks = new Set<string>()
    expect(computePrimitiveSelection(BODY, queries, normal, picks, LAYER)).toEqual([false, true, false])
  })

  it('groups a persisted pick only when the query itself is non-unique', () => {
    // No live pickKey + a duplicated query = honest grouping (a query-coverage
    // gap, not a selection bug). Both matching primitives light up.
    const queries = ['Q', 'Q', 'R']
    const normal = new Set(['Q'])
    const picks = new Set<string>()
    expect(computePrimitiveSelection(BODY, queries, normal, picks, LAYER)).toEqual([true, true, false])
  })

  it('gates a stale pickKey whose query has left the normal selection', () => {
    // selectedPickKeys still holds edge 0's key but its query was toggled out of
    // normalSelection: nothing highlights, no orphan ghost selection.
    const queries = ['Q', 'Q', 'R']
    const normal = new Set<string>()
    const picks = new Set([pk(0)])
    expect(computePrimitiveSelection(BODY, queries, normal, picks, LAYER)).toEqual([false, false, false])
  })

  it('highlights multiple distinct live picks independently', () => {
    const queries = ['Q', 'Q', 'R']
    const normal = new Set(['Q', 'R'])
    const picks = new Set([pk(1), pk(2)])
    // Edge 0 shares Q with the claimed edge 1, so it stays dark; 1 and 2 are
    // the precise picks.
    expect(computePrimitiveSelection(BODY, queries, normal, picks, LAYER)).toEqual([false, true, true])
  })

  it('ignores a same-index pick key from another layer (no cross-layer claim)', () => {
    // A VERTEX was precisely picked at index 0; nothing in the face layer was.
    // Two faces share query Q, so both should highlight by membership. A
    // layer-blind pick key would make the vertex's `BODY#0` masquerade as face 0,
    // claim Q, and wrongly isolate face 0 to [true, false]. Layer-qualified keys
    // keep the vertex pick from touching the face layer.
    const queries = ['Q', 'Q']
    const normal = new Set(['Q'])
    const vertexKey0 = primitivePickKey(BODY, 0, 'vertex')
    const picks = new Set([vertexKey0])
    expect(computePrimitiveSelection(BODY, queries, normal, picks, 'face')).toEqual([true, true])
  })
})
