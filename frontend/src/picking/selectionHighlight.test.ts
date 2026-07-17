import { describe, it, expect } from 'vitest'
import { computeHighlight, type ActiveHighlight } from './selectionHighlight'
import { primitivePickKey } from './pickKey'

const BODY = 'extrude1/body0'
const LAYER = 'edge'
const pk = (i: number) => primitivePickKey(BODY, i, LAYER)

// Bundle the loose (queries, pickKeys) pair into the ActiveHighlight shape.
const active = (queries: Set<string>, pickKeys: Set<string>): ActiveHighlight => ({ queries, pickKeys })

describe('computeHighlight', () => {
  it('isolates the single live pick when two primitives share a query', () => {
    // Edges 0 and 1 collide on query "Q"; edge 2 is unique. The user pointed at
    // edge 0, so only edge 0 highlights -- the grouping is gone.
    const queries = ['Q', 'Q', 'R']
    const a = active(new Set(['Q']), new Set([pk(0)]))
    expect(computeHighlight(BODY, LAYER, queries, a)).toEqual([true, false, false])
  })

  it('falls back to query membership for a persisted pick with no live pickKey', () => {
    // After a re-solve the pickKey is gone; the stored query re-highlights. A
    // unique query hits exactly one primitive.
    const queries = ['Q', 'R', 'S']
    const a = active(new Set(['R']), new Set<string>())
    expect(computeHighlight(BODY, LAYER, queries, a)).toEqual([false, true, false])
  })

  it('groups a persisted pick only when the query itself is non-unique', () => {
    // No live pickKey + a duplicated query = honest grouping (a query-coverage
    // gap, not a selection bug). Both matching primitives light up.
    const queries = ['Q', 'Q', 'R']
    const a = active(new Set(['Q']), new Set<string>())
    expect(computeHighlight(BODY, LAYER, queries, a)).toEqual([true, true, false])
  })

  it('gates a stale pickKey whose query has left the active set', () => {
    // pickKeys still holds edge 0's key but its query was toggled out of the
    // active query set: nothing highlights, no orphan ghost selection.
    const queries = ['Q', 'Q', 'R']
    const a = active(new Set<string>(), new Set([pk(0)]))
    expect(computeHighlight(BODY, LAYER, queries, a)).toEqual([false, false, false])
  })

  it('highlights multiple distinct live picks independently', () => {
    const queries = ['Q', 'Q', 'R']
    const a = active(new Set(['Q', 'R']), new Set([pk(1), pk(2)]))
    // Edge 0 shares Q with the claimed edge 1, so it stays dark; 1 and 2 are
    // the precise picks.
    expect(computeHighlight(BODY, LAYER, queries, a)).toEqual([false, true, true])
  })

  it('ignores a same-index pick key from another layer (no cross-layer claim)', () => {
    // A VERTEX was precisely picked at index 0; nothing in the face layer was.
    // Two faces share query Q, so both should highlight by membership. A
    // layer-blind pick key would make the vertex's `BODY#0` masquerade as face 0,
    // claim Q, and wrongly isolate face 0 to [true, false]. Layer-qualified keys
    // keep the vertex pick from touching the face layer.
    const queries = ['Q', 'Q']
    const vertexKey0 = primitivePickKey(BODY, 0, 'vertex')
    const a = active(new Set(['Q']), new Set([vertexKey0]))
    expect(computeHighlight(BODY, 'face', queries, a)).toEqual([true, true])
  })
})
