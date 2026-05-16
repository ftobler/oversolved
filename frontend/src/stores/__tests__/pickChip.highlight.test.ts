/**
 * Pick-chip highlight contract.
 *
 * User invariant (solver_arch.user.md §Pick Chips):
 *   "Everything the pick chip contains must be highlighted -- same highlight
 *    mechanism as normal selection."
 *
 * The implementation merges chip values into `normalSelection` directly via
 * `syncChipSelection`, tagging them in `chipOwnedSelection` so they can be
 * reverted when the chip deactivates. There is no parallel highlight set.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'

beforeEach(() => {
  useSketchEditorStore.setState({
    normalSelection: new Set(),
    chipOwnedSelection: new Set(),
    pendingPickField: null,
  })
})

function isSelected(query: string): boolean {
  return useSketchEditorStore.getState().normalSelection.has(query)
}

describe('pick chip highlight === selection highlight', () => {
  it('body query synced via chip is treated as selected', () => {
    useSketchEditorStore.getState().syncChipSelection(['@body_ex1'])
    expect(isSelected('@body_ex1')).toBe(true)
  })

  it('face query synced via chip is treated as selected', () => {
    useSketchEditorStore.getState().syncChipSelection(['@ex1/face/3'])
    expect(isSelected('@ex1/face/3')).toBe(true)
  })

  it('edge query synced via chip is treated as selected', () => {
    useSketchEditorStore.getState().syncChipSelection(['@ex1/edge/2'])
    expect(isSelected('@ex1/edge/2')).toBe(true)
  })

  it('sketch entity query synced via chip is treated as selected', () => {
    useSketchEditorStore.getState().syncChipSelection(['entity:sk1:line1'])
    expect(isSelected('entity:sk1:line1')).toBe(true)
  })

  it('sketch vertex query synced via chip is treated as selected', () => {
    useSketchEditorStore.getState().syncChipSelection(['vertex:sk1:line1:start'])
    expect(isSelected('vertex:sk1:line1:start')).toBe(true)
  })

  it('chip values join existing normal selection -- both contribute to highlight', () => {
    useSketchEditorStore.setState({ normalSelection: new Set(['@body_ex1']) })
    useSketchEditorStore.getState().syncChipSelection(['@ex1/face/0', 'entity:sk1:line1'])
    expect(isSelected('@body_ex1')).toBe(true)
    expect(isSelected('@ex1/face/0')).toBe(true)
    expect(isSelected('entity:sk1:line1')).toBe(true)
    expect(isSelected('@other')).toBe(false)
  })
})
