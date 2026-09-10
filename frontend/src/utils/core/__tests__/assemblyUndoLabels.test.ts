import { describe, it, expect } from 'vitest'
import { ASSEMBLY_UNDO_LABELS } from '@/utils/core/assemblyUndoLabels'

// The explicit pairing the compile-time map cannot make on its own: a new key
// added to ASSEMBLY_UNDO_LABELS without joining this list fails the
// sort-equality gate, the assembly analogue of the part side's
// ALL_MUTATION_TYPES checklist.
export const ALL_ASSEMBLY_UNDO_LABELS = [
  'Add mate',
  'Add part',
  'Delete mate',
  'Delete part',
  'Duplicate part',
  'Edit mate',
  'Fix/unfix part',
  'Move part',
  'Pick mate reference',
  'Rename mate',
  'Reorder mate',
  'Reorder part',
  'Set position',
  'Set rotation',
  'Toggle plane visibility',
  'Toggle visibility',
].sort()

describe('assemblyUndoLabels', () => {
  it('matches the explicit label list exactly', () => {
    expect(Object.values(ASSEMBLY_UNDO_LABELS).sort()).toEqual(ALL_ASSEMBLY_UNDO_LABELS)
  })

  it('every label is a non-empty string', () => {
    for (const value of Object.values(ASSEMBLY_UNDO_LABELS)) {
      expect(typeof value).toBe('string')
      expect(value.length).toBeGreaterThan(0)
    }
  })

  it('no label is duplicated', () => {
    const values = Object.values(ASSEMBLY_UNDO_LABELS)
    expect(new Set(values).size).toBe(values.length)
  })
})
