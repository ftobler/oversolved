// Step 1 of failed-modifier-pick-hint, pinned so the finding cannot rot: the
// pick field's ARMED path already draws its picks.
//
// PickChip mirrors its values into the store's chipOwnedSelection while
// `isPicking`, syncChipSelection merges them into normalSelection, and Body3D's
// selection highlight is query membership. So an armed field paints its picks
// in the SELECTION colour (orange), not the hint colour, and a pick that no
// longer resolves is invisible even then.
//
// The gap this file does not cover is every state where no field is armed: a
// selected tree row, and an open editor whose first field is not armed. Those
// are driven by the relation hints (see registry/__tests__).

import { describe, it, expect, beforeEach } from 'vitest'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { HighlightIndex } from '@/picking/selectionHighlight'
import { selectActiveFrom } from '@/picking/highlightActive'
import { EDGE_LAYER_NAME } from '@/picking/layerNames'

const pickOne = '?1;@u|one@fi1@body_ex1:straightedge'
const pickTwo = '?1;@u|two@fi1@body_ex1:straightedge'
const shown = [pickOne, pickTwo, '?1;@u|other@ex1@body_ex1:straightedge']

beforeEach(() => {
  useSketchEditorStore.getState().clearNormalSelection()
  useSketchEditorStore.getState().clearChipSelection()
})

/** The flags Body3D's selection painter computes for one body. */
function selectionFlags(queries: string[]): readonly boolean[] {
  const store = useSketchEditorStore.getState()
  return new HighlightIndex('body_ex1', EDGE_LAYER_NAME, queries)
    .compute(selectActiveFrom(store.selectedPicks, store.normalSelection))
}

describe('an armed pick field paints its picks as selection', () => {
  it('every chip value resolves to its edge', () => {
    useSketchEditorStore.getState().syncChipSelection([pickOne, pickTwo])
    expect(selectionFlags(shown)).toEqual([true, true, false])
  })

  it('disarming the field clears the paint', () => {
    useSketchEditorStore.getState().syncChipSelection([pickOne])
    expect(selectionFlags(shown)[0]).toBe(true)
    useSketchEditorStore.getState().clearChipSelection()
    expect(selectionFlags(shown)).toEqual([false, false, false])
  })

  it('a pick that no longer resolves stays invisible while armed', () => {
    // The stale-pick case the plan worries about: the armed field has nothing to
    // paint because the query is not on the body at all.
    useSketchEditorStore.getState().syncChipSelection(['?1;@u|gone@fi1@body_ex1:straightedge'])
    expect(selectionFlags(shown)).toEqual([false, false, false])
  })
})
