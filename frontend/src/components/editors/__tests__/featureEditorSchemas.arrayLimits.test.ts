import { describe, it, expect } from 'vitest'
import { ARRAY_SCHEMA, CIRCULAR_ARRAY_SCHEMA } from '../featureEditorSchemas'
import { validateNumberFieldValue } from '../widgets/numberFieldValidate'
import type { NumberFieldDef } from '../widgets/fieldTypes'
import { MAX_ARRAY_COUNT, MAX_ARRAY_CELLS, arrayCountProblem } from '@/persistence/docSchema'

function field(schema: typeof ARRAY_SCHEMA, key: string): NumberFieldDef {
  return schema.fields.find(f => f.key === key) as NumberFieldDef
}

describe('array count limits in the editor', () => {
  it('refuses a count past the loader cap', () => {
    const f = field(CIRCULAR_ARRAY_SCHEMA, 'count')
    expect(validateNumberFieldValue(f, MAX_ARRAY_COUNT + 1, {})).toContain(`at most ${MAX_ARRAY_COUNT}`)
    expect(validateNumberFieldValue(f, MAX_ARRAY_COUNT, {})).toBeNull()
  })

  it('refuses a rectangular pair past the cells cap', () => {
    const data = { mode: 'rectangular', count_y: 300 }
    expect(validateNumberFieldValue(field(ARRAY_SCHEMA, 'count_x'), 400, data)).toContain(`${MAX_ARRAY_CELLS}`)
    expect(validateNumberFieldValue(field(ARRAY_SCHEMA, 'count_x'), 100, data)).toBeNull()
  })

  it('ignores a hidden count_y on a linear array', () => {
    const data = { mode: 'linear', count_y: 900 }
    expect(validateNumberFieldValue(field(ARRAY_SCHEMA, 'count_x'), 900, data)).toBeNull()
  })

  it('agrees with the shared check at the boundary values', () => {
    const f = field(ARRAY_SCHEMA, 'count_x')
    for (const v of [1, 2, 999, 1000, 1001, 2000]) {
      const data = { mode: 'rectangular', count_y: 100 }
      expect(validateNumberFieldValue(f, v, data) === null).toBe(arrayCountProblem('count_x', v, 100) === null)
    }
  })
})
