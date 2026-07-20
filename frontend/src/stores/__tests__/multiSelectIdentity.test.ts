/**
 * Multi-select identity: a selection entry is ONE primitive, not one query.
 *
 * The durable identity of a b-rep primitive is its ancestral query (UUID +
 * ancestral path). That identity is a many-to-one projection: two genuinely
 * distinct primitives legitimately share a query when neither earned a
 * construction UUID, and the ID buffer already proves they are distinct by
 * handing the click a per-primitive `pickKey` (`bodyKey#layer#index`).
 *
 * The defect these tests lock out: the store keyed the whole selection on the
 * query alone, so selecting a second primitive that shared a query silently
 * evicted the first. That reads to the user as "the old one un-selected
 * itself", and the victim is whichever entity collided rather than the oldest,
 * so it looks arbitrary instead of FIFO. It hits every entity type and is worst
 * for vertices, whose queries carry the fewest discriminating tokens.
 *
 * Store + pure highlight only -- no Viewport, no three.js scene.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { computeHighlight } from '@/picking/selectionHighlight'
import { selectActiveFrom } from '@/picking/highlightActive'
import { primitivePickKey, bodyKeyFor } from '@/picking/pickKey'
import { FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME } from '@/picking/layerNames'

const BODY = bodyKeyFor('extrude1', 'body0')

function reset() {
  useSketchEditorStore.setState({
    normalSelection: new Set(),
    selectedPicks: new Map(),
    chipOwnedSelection: new Set(),
    selectionDomain: 'sketch_2d',
    hoveredSelectionId: null,
    hoveredPickKey: null,
  })
}

/** Click primitive `i` of `layer`, carrying the query the ID buffer resolved. */
function click(layer: string, index: number, query: string) {
  useSketchEditorStore.getState().toggleNormalSelection(query, primitivePickKey(BODY, index, layer))
}

/** The highlight flags Body3D would render for `queries` in `layer`. */
function highlightOf(layer: string, queries: string[]): boolean[] {
  const { selectedPicks, normalSelection } = useSketchEditorStore.getState()
  return computeHighlight(BODY, layer, queries, selectActiveFrom(selectedPicks, normalSelection))
}

beforeEach(reset)

describe('multi-select holds one entry per primitive, not per query', () => {
  // The worst case, and the one the user hit: every primitive of a body shares a
  // single ancestral query because none of them earned a construction UUID.
  for (const layer of [VERTEX_LAYER_NAME, EDGE_LAYER_NAME, FACE_LAYER_NAME]) {
    it(`[${layer}] eight primitives sharing ONE query all stay selected`, () => {
      const queries = Array.from({ length: 8 }, () => 'Q')
      queries.forEach((q, i) => click(layer, i, q))

      // Every one of the eight is live: none evicted a predecessor.
      expect(highlightOf(layer, queries)).toEqual(queries.map(() => true))
      expect(useSketchEditorStore.getState().normalSelection.has('Q')).toBe(true)
    })

    it(`[${layer}] selecting a colliding sibling never evicts an earlier pick`, () => {
      // Non-FIFO eviction check: after EVERY click, all previously clicked
      // primitives must still be highlighted. A capacity cap would drop the
      // oldest; a key collision drops whichever entity collided. Neither may.
      const queries = Array.from({ length: 6 }, () => 'Q')
      for (let i = 0; i < queries.length; i++) {
        click(layer, i, queries[i])
        const flags = highlightOf(layer, queries)
        for (let j = 0; j <= i; j++) {
          expect(flags[j], `primitive ${j} dropped out after clicking ${i}`).toBe(true)
        }
      }
    })

    it(`[${layer}] de-selecting one collided primitive leaves its siblings alone`, () => {
      const queries = ['Q', 'Q', 'Q']
      queries.forEach((q, i) => click(layer, i, q))

      click(layer, 1, 'Q')  // second click on the middle one deselects only it

      expect(highlightOf(layer, queries)).toEqual([true, false, true])
      // The query is still durably selected: two primitives still claim it.
      expect(useSketchEditorStore.getState().normalSelection.has('Q')).toBe(true)
    })

    it(`[${layer}] the query leaves normalSelection only when its last primitive does`, () => {
      const queries = ['Q', 'Q']
      queries.forEach((q, i) => click(layer, i, q))

      click(layer, 0, 'Q')
      expect(useSketchEditorStore.getState().normalSelection.has('Q')).toBe(true)

      click(layer, 1, 'Q')
      const s = useSketchEditorStore.getState()
      expect(s.normalSelection.has('Q')).toBe(false)
      expect(s.selectedPicks.size).toBe(0)
    })
  }

  it('distinct queries keep behaving as independent selections', () => {
    const queries = ['A', 'B', 'C']
    queries.forEach((q, i) => click(EDGE_LAYER_NAME, i, q))
    expect(highlightOf(EDGE_LAYER_NAME, queries)).toEqual([true, true, true])
    expect(useSketchEditorStore.getState().normalSelection.size).toBe(3)
  })

  it('a mixed face + edge + vertex selection keeps every primitive', () => {
    // Cross-layer: the pick key is layer-qualified, so a face, an edge and a
    // vertex all sharing the query 'Q' are three separate selections.
    click(FACE_LAYER_NAME, 0, 'Q')
    click(EDGE_LAYER_NAME, 0, 'Q')
    click(VERTEX_LAYER_NAME, 0, 'Q')

    expect(highlightOf(FACE_LAYER_NAME, ['Q'])).toEqual([true])
    expect(highlightOf(EDGE_LAYER_NAME, ['Q'])).toEqual([true])
    expect(highlightOf(VERTEX_LAYER_NAME, ['Q'])).toEqual([true])
  })

  it('a click with no pickKey still toggles the whole query (sketch / plane / origin)', () => {
    // Layers with no per-primitive identity are one primitive per query by
    // construction; their toggle semantics must not change.
    const { toggleNormalSelection } = useSketchEditorStore.getState()
    toggleNormalSelection('entity:S1:L1')
    expect(useSketchEditorStore.getState().normalSelection.has('entity:S1:L1')).toBe(true)
    toggleNormalSelection('entity:S1:L1')
    expect(useSketchEditorStore.getState().normalSelection.has('entity:S1:L1')).toBe(false)
  })

  it('clicking a query-only selection with a pickKey deselects it', () => {
    // After a re-solve the live pickKeys are gone but the query survives in
    // normalSelection. A click on that primitive must still deselect it rather
    // than add a claim to something the user meant to turn off.
    useSketchEditorStore.getState().addToNormalSelection('Q')
    click(EDGE_LAYER_NAME, 0, 'Q')
    expect(useSketchEditorStore.getState().normalSelection.has('Q')).toBe(false)
  })
})
