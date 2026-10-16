// The parameter table's model, pure: which variables become rows, what the
// value column shows, and the mutation each edited cell writes. The dialog
// beside it only renders these rows and dispatches these mutations.
import { describe, it, expect } from 'vitest'
import { parameterEditMutations, parameterRows, parameterValueText, UNIT_OPTIONS } from '@/pages/partParameters'
import type { PartFeature, SketchData } from '@/types/cad'

const variable = (id: string, label: string, expression: string | number, unit?: string): PartFeature => ({
  id, kind: 'variable', label, variable: { expression, ...(unit !== undefined ? { unit } : {}) },
})

const sketch: PartFeature = { id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front' }

const result = (over: Partial<SketchData>): SketchData => ({ solved: over.solved ?? ({} as SketchData['solved']), ...over })

describe('parameterRows', () => {
  it('lists every variable in document order with its expression and unit', () => {
    const rows = parameterRows(
      [sketch, variable('v1', 'width', 20, 'mm'), variable('v2', 'angle', 'width/2', 'deg')],
      undefined,
    )
    expect(rows.map((r) => [r.id, r.name, r.expression, r.unit])).toEqual([
      ['v1', 'width', '20', 'mm'],
      ['v2', 'angle', 'width/2', 'deg'],
    ])
    expect(rows.every((r) => r.value === null && r.error === null)).toBe(true)
  })

  it('reads the solved value and the solve error from the result bag', () => {
    const rows = parameterRows(
      [variable('v1', 'width', 20), variable('v2', 'oops', 'nope')],
      {
        v1: result({ value: 20 }),
        v2: result({ exception: 'Cannot evaluate "nope"' }),
      },
    )
    expect(rows[0].value).toBe(20)
    expect(rows[0].error).toBeNull()
    expect(rows[1].value).toBeNull()
    expect(rows[1].error).toBe('Cannot evaluate "nope"')
  })

  it('falls back to the id when a variable carries no label', () => {
    const rows = parameterRows([{ id: 'v9', kind: 'variable', variable: { expression: 1 } }], undefined)
    expect(rows[0].name).toBe('v9')
  })

  it('shows a placeholder before the first solve lands, and the error instead of a value', () => {
    expect(parameterValueText({ id: 'v1', name: 'w', expression: '1', unit: '', value: null, error: null })).toBe('...')
    expect(parameterValueText({ id: 'v1', name: 'w', expression: '1', unit: '', value: 2.5, error: null })).toBe('2.5')
    expect(parameterValueText({ id: 'v1', name: 'w', expression: '1', unit: '', value: null, error: 'bad' })).toBe('bad')
  })
})

describe('parameterEditMutations', () => {
  const row = { id: 'v1', name: 'width', expression: '20', unit: 'mm', value: 20, error: null }

  it('renames through rename_feature', () => {
    expect(parameterEditMutations(row, 'name', 'plate width')).toEqual([
      { type: 'rename_feature', featureId: 'v1', label: 'plate width' },
    ])
  })

  it('refuses an empty name (a variable must stay addressable)', () => {
    expect(parameterEditMutations(row, 'name', '   ')).toEqual([])
  })

  it('writes the expression and the unit through set_variable_field', () => {
    expect(parameterEditMutations(row, 'expression', 'width + 5')).toEqual([
      { type: 'set_variable_field', featureId: 'v1', field: 'expression', value: 'width + 5' },
    ])
    expect(parameterEditMutations(row, 'unit', 'deg')).toEqual([
      { type: 'set_variable_field', featureId: 'v1', field: 'unit', value: 'deg' },
    ])
  })

  it('clears the unit on an empty string rather than storing a blank', () => {
    expect(parameterEditMutations(row, 'unit', '')).toEqual([
      { type: 'set_variable_field', featureId: 'v1', field: 'unit', value: null },
    ])
  })

  it('offers the unit hints without a duplicate blank', () => {
    expect(UNIT_OPTIONS[0]).toBe('')
    expect(new Set(UNIT_OPTIONS).size).toBe(UNIT_OPTIONS.length)
  })
})
