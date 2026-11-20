// The part set a pick chip resolves against is one rule, not two: during a
// feature edit the chip reads the PRE-feature pick layer, because the preview
// has already consumed the parts the user picks (a boolean tool, a deleted
// part). The Parts card reads the same rule while a part field is armed, so a
// row click cannot name a body the chip would resolve to nothing.
import { describe, it, expect } from 'vitest'
import { pickLayerParts, selectPartsListParts } from '@/stores/partEditorStore'
import type { PartResult } from '@/types/cad'

const part = (id: string, createdBy: string): PartResult => ({ id, created_by: createdBy, modified_by: [] })

const PREVIEW: Record<string, PartResult> = { body_bo1: part('body_bo1', 'bo1') }
const PICK_LAYER: Record<string, PartResult> = {
  body_ex1: part('body_ex1', 'ex1'),
  body_ex2: part('body_ex2', 'ex2'),
}
const ARMED_PART = { featureId: 'bo1', field: 'tools', names: 'body' as const }
const ARMED_EDGE = { featureId: 'bo1', field: 'edges' }

describe('pickLayerParts', () => {
  it('is the pick layer whenever a feature edit published one', () => {
    expect(pickLayerParts({ parts: PREVIEW, pickParts: PICK_LAYER })).toBe(PICK_LAYER)
  })

  it('falls back to the preview when no edit is open', () => {
    expect(pickLayerParts({ parts: PREVIEW, pickParts: {} })).toBe(PREVIEW)
  })

  it('falls back to the preview before the pick-layer solve lands', () => {
    // Entering an edit flips the FSM before the two-world solve returns.
    expect(pickLayerParts({ parts: PREVIEW, pickParts: {} })).toBe(PREVIEW)
  })
})

describe('selectPartsListParts', () => {
  it('lists the pick layer while a part field is armed during an edit', () => {
    expect(selectPartsListParts({ parts: PREVIEW, pickParts: PICK_LAYER }, ARMED_PART)).toBe(PICK_LAYER)
  })

  it('keeps the preview outside an armed field, so the edit result stays in sight', () => {
    expect(selectPartsListParts({ parts: PREVIEW, pickParts: PICK_LAYER }, null)).toBe(PREVIEW)
  })

  it('keeps the preview while an element field is armed: its rows are no pick surface', () => {
    expect(selectPartsListParts({ parts: PREVIEW, pickParts: PICK_LAYER }, ARMED_EDGE)).toBe(PREVIEW)
  })

  it('lists the preview outside an edit even with a part field armed', () => {
    expect(selectPartsListParts({ parts: PICK_LAYER, pickParts: {} }, ARMED_PART)).toBe(PICK_LAYER)
  })

  it('agrees with the chip fallback while a part field is armed', () => {
    const state = { parts: PREVIEW, pickParts: PICK_LAYER }
    expect(selectPartsListParts(state, ARMED_PART)).toBe(pickLayerParts(state))
  })
})
