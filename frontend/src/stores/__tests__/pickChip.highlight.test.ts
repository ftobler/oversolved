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
  })
})

function isSelected(query: string): boolean {
  return useSketchEditorStore.getState().normalSelection.has(query)
}

describe('pick chip highlight === selection highlight', () => {
  // One case per id family the chip can carry: body, face, edge, sketch entity
  // and sketch vertex. Each is just a value for the same sync -> selected path.
  it.each([
    '@body_ex1',
    '@ex1/face/3',
    '@ex1/edge/2',
    'entity:sk1:line1',
    'vertex:sk1:line1:start',
  ])('a query synced via chip is treated as selected: %s', (query) => {
    useSketchEditorStore.getState().syncChipSelection([query])
    expect(isSelected(query)).toBe(true)
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
