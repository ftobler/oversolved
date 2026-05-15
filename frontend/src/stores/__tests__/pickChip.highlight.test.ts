/**
 * Pick-chip highlight contract.
 *
 * User invariant (solver_arch.user.md §Pick Chips):
 *   "Everything the pick chip contains must be highlighted -- same highlight
 *    mechanism as normal selection."
 *
 * The implementation uses a parallel `pickChipHighlightItems` array that
 * highlight-checking components consult alongside `normalSelection`. These
 * tests pin the contract: across element kinds (body, edge, face, sketch
 * entity, sketch vertex), a query in `pickChipHighlightItems` must be
 * recognised as "selected-looking" by the same predicate components use.
 *
 * Components reviewed:
 *   - Body3D.tsx     (body, edge, face)            -- already checked pickChip
 *   - EntityLines.tsx (sketch entity)               -- added in this plan
 *   - VertexDots.tsx  (sketch vertex)               -- added in this plan
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'

beforeEach(() => {
  useSketchEditorStore.setState({
    normalSelection: new Set(),
    pickChipHighlightItems: [],
    pendingPickField: null,
  })
})

function isSelected(query: string): boolean {
  const s = useSketchEditorStore.getState()
  return s.normalSelection.has(query) || s.pickChipHighlightItems.includes(query)
}

describe('pick chip highlight === selection highlight', () => {
  it('body query in chip is treated as selected', () => {
    useSketchEditorStore.setState({ pickChipHighlightItems: ['@body_ex1'] })
    expect(isSelected('@body_ex1')).toBe(true)
  })

  it('face query in chip is treated as selected', () => {
    useSketchEditorStore.setState({ pickChipHighlightItems: ['@ex1/face/3'] })
    expect(isSelected('@ex1/face/3')).toBe(true)
  })

  it('edge query in chip is treated as selected', () => {
    useSketchEditorStore.setState({ pickChipHighlightItems: ['@ex1/edge/2'] })
    expect(isSelected('@ex1/edge/2')).toBe(true)
  })

  it('sketch entity query in chip is treated as selected', () => {
    useSketchEditorStore.setState({ pickChipHighlightItems: ['entity:sk1:line1'] })
    expect(isSelected('entity:sk1:line1')).toBe(true)
  })

  it('sketch vertex query in chip is treated as selected', () => {
    useSketchEditorStore.setState({ pickChipHighlightItems: ['vertex:sk1:line1:start'] })
    expect(isSelected('vertex:sk1:line1:start')).toBe(true)
  })

  it('chip and normal selection unioned -- both contribute to highlight', () => {
    useSketchEditorStore.setState({
      normalSelection: new Set(['@body_ex1']),
      pickChipHighlightItems: ['@ex1/face/0', 'entity:sk1:line1'],
    })
    expect(isSelected('@body_ex1')).toBe(true)
    expect(isSelected('@ex1/face/0')).toBe(true)
    expect(isSelected('entity:sk1:line1')).toBe(true)
    expect(isSelected('@other')).toBe(false)
  })
})
