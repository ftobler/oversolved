import { describe, it, expect } from 'vitest'
import { computeHighlight } from '../selectionHighlight'
import { selectActiveFrom, hoverActiveFrom } from '../highlightActive'
import { primitivePickKey, bodyKeyFor } from '../pickKey'
import { FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME } from '../layerNames'

/**
 * The point of the selection/hover unification: face / edge / vertex and hover /
 * click all decide highlighting through the ONE computeHighlight function, and
 * both framings are assembled by the SAME two builders Body3D uses
 * (selectActiveFrom / hoverActiveFrom, from highlightActive.ts). There is no
 * second path. This suite is the anti-regression that keeps it that way: it does
 * NOT re-implement the framing locally, so if Body3D is ever rewired to a
 * divergent hover path the parity assertions below break.
 *
 * Click and hover differ only in how the ActiveHighlight is assembled, never in
 * the decision. selectActiveFrom mirrors the store's durable state
 * (selectedPicks, normalSelection); hoverActiveFrom carries a transient
 * pointed primitive of size <= 1 (hoveredPickKey, hoveredSelectionId).
 */

const BODY = bodyKeyFor('extrude1', 'body0')
const LAYERS = [FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME]

describe('highlight symmetry across {face, edge, vertex} x {hover, click}', () => {
  // A single primitive pointed at, whose query collides with a sibling. A hover
  // and a click built from the SAME resolved hit (same pickKey, same query) must
  // highlight identically -- this is the Body3D-level wiring, exercised through
  // the exact builders Body3D imports.
  for (const layer of LAYERS) {
    it(`[${layer}] hover and click on the same hit produce identical flags`, () => {
      const queries = ['Q', 'Q', 'R']
      const pointedPickKey = primitivePickKey(BODY, 0, layer)
      const pointedQuery = 'Q'

      const clickFlags = computeHighlight(BODY, layer, queries,
        selectActiveFrom(new Map([[pointedQuery, pointedPickKey]]), new Set([pointedQuery])))
      const hoverFlags = computeHighlight(BODY, layer, queries,
        hoverActiveFrom(pointedPickKey, pointedQuery))

      expect(hoverFlags).toEqual(clickFlags)
      // ...and the shared active identity isolates exactly the pointed primitive.
      expect(clickFlags).toEqual([true, false, false])
    })

    it(`[${layer}] precise pickKey isolates exactly index i, in both framings`, () => {
      const queries = ['Q', 'Q', 'Q']  // worst case: every sibling shares the query
      for (let i = 0; i < queries.length; i++) {
        const pkI = primitivePickKey(BODY, i, layer)
        const expected = queries.map((_, j) => j === i)
        expect(computeHighlight(BODY, layer, queries,
          selectActiveFrom(new Map([['Q', pkI]]), new Set(['Q'])))).toEqual(expected)
        expect(computeHighlight(BODY, layer, queries,
          hoverActiveFrom(pkI, 'Q'))).toEqual(expected)
      }
    })

    it(`[${layer}] a pickKey minted by another layer highlights nothing`, () => {
      const queries = ['Q', 'Q', 'Q']
      const otherLayer = LAYERS.find(l => l !== layer)!
      const foreignKey = primitivePickKey(BODY, 0, otherLayer)
      // The foreign pickKey never matches this layer, and its query is not active,
      // so nothing lights up in either framing.
      expect(computeHighlight(BODY, layer, queries,
        selectActiveFrom(new Map([['Q', foreignKey]]), new Set<string>()))).toEqual([false, false, false])
      expect(computeHighlight(BODY, layer, queries,
        hoverActiveFrom(foreignKey, null))).toEqual([false, false, false])
    })

    it(`[${layer}] query-only active groups shared-query siblings (expected until unique queries)`, () => {
      // No pickKey rode in (a persisted pick after re-solve, or a query-only
      // hover). The durable query fallback groups EVERY sibling that shares the
      // query. This residual grouping is inherent to non-unique queries and is
      // the seam to naming-by-construction, not a bug -- both framings agree.
      const queries = ['Q', 'Q', 'R']
      const clickFlags = computeHighlight(BODY, layer, queries,
        selectActiveFrom(new Map<string, string>(), new Set(['Q'])))
      const hoverFlags = computeHighlight(BODY, layer, queries,
        hoverActiveFrom(null, 'Q'))
      expect(clickFlags).toEqual([true, true, false])
      expect(hoverFlags).toEqual(clickFlags)
    })
  }

  it('re-selecting a query via a shared-query sibling isolates only that sibling', () => {
    // The store scenario behind the query-keyed selectedPicks map: edge A
    // (index 0) claimed Q, a click on sibling B toggled Q off (claim dropped
    // with it), a second click on B re-selected Q with B's key. Only B may
    // highlight -- a pickKey-keyed claim store leaked A's key through the
    // off/on cycle and lit both.
    const layer = EDGE_LAYER_NAME
    const queries = ['Q', 'Q']
    const kB = primitivePickKey(BODY, 1, layer)
    expect(computeHighlight(BODY, layer, queries,
      selectActiveFrom(new Map([['Q', kB]]), new Set(['Q'])))).toEqual([false, true])
  })

  it('an empty hover (nothing under the cursor) highlights nothing', () => {
    const queries = ['Q', 'Q', 'R']
    for (const layer of LAYERS) {
      expect(computeHighlight(BODY, layer, queries,
        hoverActiveFrom(null, null))).toEqual([false, false, false])
    }
  })

  it('the shared empty set keeps an empty hover reference-stable across builds', () => {
    // Two independent empty hovers must reuse the SAME set instances so the memos
    // in Body3D do not thrash. This pins the reference-stability contract the
    // builder promises.
    const a = hoverActiveFrom(null, null)
    const b = hoverActiveFrom(null, null)
    expect(a.pickKeys).toBe(b.pickKeys)
    expect(a.queries).toBe(b.queries)
    expect(a.pickKeys).toBe(a.queries)
  })
})
