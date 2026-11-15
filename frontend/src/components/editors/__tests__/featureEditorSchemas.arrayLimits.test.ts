import { describe, it, expect } from 'vitest'
import { LINEAR_PATTERN_SCHEMA } from '../featureEditorSchemas'
import { validateNumberFieldValue } from '../widgets/numberFieldValidate'
import type { NumberFieldDef } from '../widgets/fieldTypes'
import { MAX_ARRAY_COUNT, MAX_ARRAY_CELLS, arrayCountProblem } from '@/persistence/docSchema'

function field(key: string): NumberFieldDef {
  return LINEAR_PATTERN_SCHEMA.fields.find(f => f.key === key) as NumberFieldDef
}

describe('pattern count limits in the editor', () => {
  it('refuses a count past the loader cap', () => {
    const f = field('count')
    expect(validateNumberFieldValue(f, MAX_ARRAY_COUNT + 1, {})).toContain(`at most ${MAX_ARRAY_COUNT}`)
    expect(validateNumberFieldValue(f, MAX_ARRAY_COUNT, {})).toBeNull()
  })

  it('refuses a second-direction pair past the cells cap', () => {
    const data = { second_direction: true, count: 300 }
    expect(validateNumberFieldValue(field('count_2'), 400, data)).toContain(`${MAX_ARRAY_CELLS}`)
    expect(validateNumberFieldValue(field('count_2'), 100, data)).toBeNull()
  })

  it('agrees with the shared check at the boundary values', () => {
    const f = field('count_2')
    for (const v of [1, 2, 999, 1000, 1001, 2000]) {
      const data = { second_direction: true, count: 100 }
      expect(validateNumberFieldValue(f, v, data) === null).toBe(arrayCountProblem('count_2', v, 100) === null)
    }
  })

  it('accepts 1x1 and count 1, the quiet no-ops', () => {
    expect(arrayCountProblem('count', 1)).toBeNull()
    expect(arrayCountProblem('count_2', 1, 1)).toBeNull()
    expect(arrayCountProblem('count', 0)).toContain('whole number of at least 1')
  })

  it('sees an expression-string sibling when it evaluates to 1', () => {
    const data = { second_direction: true, count: '1' }
    expect(validateNumberFieldValue(field('count_2'), 1, data)).toBeNull()
  })
})
