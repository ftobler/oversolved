import { describe, it, expect } from 'vitest'
import { computeHighlight, HighlightIndex, type ActiveHighlight } from '../selectionHighlight'
import { primitivePickKey } from '../pickKey'

const BODY = 'extrude1/body0'
const LAYER = 'edge'
const pk = (i: number) => primitivePickKey(BODY, i, LAYER)

// Bundle the loose (queries, claims) pair into the ActiveHighlight shape, where
// claims maps the query each pickKey was recorded under -> its keys.
const active = (queries: Set<string>, claims: ReadonlyMap<string, ReadonlySet<string>>): ActiveHighlight => ({ queries, pickKeys: claims })

describe('computeHighlight', () => {
  it('isolates the single live pick when two primitives share a query', () => {
    // Edges 0 and 1 collide on query "Q"; edge 2 is unique. The user pointed at
    // edge 0, so only edge 0 highlights -- the grouping is gone.
    const queries = ['Q', 'Q', 'R']
    const a = active(new Set(['Q']), new Map([['Q', new Set([pk(0)])]]))
    expect(computeHighlight(BODY, LAYER, queries, a)).toEqual([true, false, false])
  })

  it('falls back to query membership for a persisted pick with no live pickKey', () => {
    // After a re-solve the pickKeys are gone; the stored query re-highlights. A
    // unique query hits exactly one primitive.
    const queries = ['Q', 'R', 'S']
    const a = active(new Set(['R']), new Map())
    expect(computeHighlight(BODY, LAYER, queries, a)).toEqual([false, true, false])
  })

  it('groups a persisted pick only when the query itself is non-unique', () => {
    // No live pickKey + a duplicated query = honest grouping (a query-coverage
    // gap, not a selection bug). Both matching primitives light up.
    const queries = ['Q', 'Q', 'R']
    const a = active(new Set(['Q']), new Map())
    expect(computeHighlight(BODY, LAYER, queries, a)).toEqual([true, true, false])
  })

  it('gates a stale pickKey whose query has left the active set', () => {
    // pickKeys still holds edge 0's key but its query was toggled out of the
    // active query set: nothing highlights, no orphan ghost selection.
    const queries = ['Q', 'Q', 'R']
    const a = active(new Set<string>(), new Map([['Q', new Set([pk(0)])]]))
    expect(computeHighlight(BODY, LAYER, queries, a)).toEqual([false, false, false])
  })

  it('highlights multiple distinct live picks independently', () => {
    const queries = ['Q', 'Q', 'R']
    const a = active(new Set(['Q', 'R']), new Map([['Q', new Set([pk(1)])], ['R', new Set([pk(2)])]]))
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
    const a = active(new Set(['Q']), new Map([['Q', new Set([vertexKey0])]]))
    expect(computeHighlight(BODY, 'face', queries, a)).toEqual([true, true])
  })

  it('a claim whose index now owns another query is inert (topology shift)', () => {
    // The claim was recorded under Q when primitive 0 carried Q; a re-solve
    // shifted indices so primitive 0 now carries R. The stale claim must be
    // inert: Q still highlights by membership, R's primitives are not isolated
    // by the claim, and the sibling R primitive at index 2 is not suppressed.
    const queries = ['R', 'Q', 'R']
    const a = active(new Set(['Q', 'R']), new Map([['Q', new Set([pk(0)])]]))
    expect(computeHighlight(BODY, LAYER, queries, a)).toEqual([true, true, true])
  })

  it('a claim for an active query whose index left the body highlights nothing of it', () => {
    // The claim under Q names index 0, but primitive 0 now carries R and R is
    // not active. The stale claim must not isolate index 0 (it is not part of
    // the durable selection) nor suppress Q's siblings.
    const queries = ['R', 'Q', 'Q']
    const a = active(new Set(['Q']), new Map([['Q', new Set([pk(0)])]]))
    expect(computeHighlight(BODY, LAYER, queries, a)).toEqual([false, true, true])
  })
})

// The index exists purely so a pointer move stays cheap on a heavy model: bodies
// the pointer never touched must answer without scanning their primitives AND
// without changing the identity of their answer, because the colour-buffer memos
// downstream are keyed on that identity. Both are asserted here.
describe('HighlightIndex', () => {
  const queries = ['Q', 'Q', 'R']
  const index = () => new HighlightIndex(BODY, LAYER, queries)

  it('agrees with computeHighlight whenever the body is involved', () => {
    const cases: ActiveHighlight[] = [
      active(new Set(['Q']), new Map([['Q', new Set([pk(0)])]])),
      active(new Set(['Q']), new Map()),
      active(new Set(['Q', 'R']), new Map([['Q', new Set([pk(1)])], ['R', new Set([pk(2)])]])),
      active(new Set(['R']), new Map([['Q', new Set([pk(0)])]])),
    ]
    const idx = index()
    for (const a of cases) {
      expect(idx.compute(a)).toEqual(computeHighlight(BODY, LAYER, queries, a))
    }
  })

  it('returns the same all-false array for every active set that misses this body', () => {
    const idx = index()
    const first = idx.compute(active(new Set(['elsewhere']), new Map([['elsewhere', new Set(['other#edge#0'])]])))
    const second = idx.compute(active(new Set(['also-elsewhere']), new Map()))
    const empty = idx.compute(active(new Set<string>(), new Map()))
    expect(first).toEqual([false, false, false])
    // Identity, not just equality: a changed reference would re-run every memo
    // that rebuilds this body's vertex colours and re-uploads them to the GPU.
    expect(second).toBe(first)
    expect(empty).toBe(first)
    expect(first).toBe(idx.none)
  })

  it('gates a stale pickKey through the index too (no ghost highlight)', () => {
    // Query left the active set, pick key stayed: the index must not treat the
    // lingering pick key as a reason to highlight.
    expect(index().compute(active(new Set<string>(), new Map([['Q', new Set([pk(0)])]])))).toEqual([false, false, false])
  })

  it('hasAny is false for the shared all-false answer and true for a real hit', () => {
    const idx = index()
    expect(idx.hasAny(idx.compute(active(new Set(['elsewhere']), new Map())))).toBe(false)
    expect(idx.hasAny(idx.compute(active(new Set(['R']), new Map())))).toBe(true)
    expect(idx.hasAny(null)).toBe(false)
  })

  it('answers a wide selection without scanning the body, and vice versa', () => {
    // Both directions of the size asymmetry: a 5k-entry selection against a 3-face
    // body, and a 5k-face body against a one-query hover. Either way the answer is
    // the shared all-false array when the two sets do not meet.
    const wide = active(new Set(Array.from({ length: 5000 }, (_, i) => `far${i}`)), new Map())
    expect(index().compute(wide)).toEqual([false, false, false])

    const bigBody = new HighlightIndex(BODY, LAYER, Array.from({ length: 5000 }, (_, i) => `q${i}`))
    expect(bigBody.compute(active(new Set(['q4999']), new Map()))[4999]).toBe(true)
    expect(bigBody.compute(active(new Set(['nope']), new Map()))).toBe(bigBody.none)
  })
})
