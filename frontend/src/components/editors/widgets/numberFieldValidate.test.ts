import { describe, it, expect } from 'vitest'
import { validateNumberFieldValue } from './numberFieldValidate'
import type { NumberFieldDef } from './fieldTypes'

function field(over: Partial<NumberFieldDef> = {}): NumberFieldDef {
  return { type: 'number', key: 'count', label: 'Count', ...over }
}

describe('validateNumberFieldValue', () => {
  it('accepts anything when the field declares no constraint', () => {
    expect(validateNumberFieldValue(field(), 2.5)).toBe(true)
    expect(validateNumberFieldValue(field(), -7)).toBe(true)
  })

  it('still defers to the schema validate predicate', () => {
    const f = field({ validate: (v) => v > 0 })
    expect(validateNumberFieldValue(f, 3)).toBe(true)
    expect(validateNumberFieldValue(f, 0)).toBe(false)
  })

  it("rejects a fractional value when parse is 'int'", () => {
    const f = field({ parse: 'int', validate: (v) => v > 0 })
    expect(validateNumberFieldValue(f, 2)).toBe(true)
    expect(validateNumberFieldValue(f, 2.5)).toBe(false)
  })

  it("rejects a non-finite value when parse is 'int'", () => {
    const f = field({ parse: 'int' })
    expect(validateNumberFieldValue(f, NaN)).toBe(false)
    expect(validateNumberFieldValue(f, Infinity)).toBe(false)
  })

  it("leaves a float field alone when parse is 'float'", () => {
    expect(validateNumberFieldValue(field({ parse: 'float' }), 2.5)).toBe(true)
  })

  it('rejects a value below the declared min', () => {
    const f = field({ min: 1 })
    expect(validateNumberFieldValue(f, 0)).toBe(false)
    expect(validateNumberFieldValue(f, 1)).toBe(true)
    expect(validateNumberFieldValue(f, 2)).toBe(true)
  })

  it('rejects NaN when a min is declared', () => {
    expect(validateNumberFieldValue(field({ min: 0 }), NaN)).toBe(false)
  })

  it('still enforces min alongside parse and validate, as count_x does', () => {
    const f = field({ parse: 'int', validate: (v) => v > 0, min: 1 })
    expect(validateNumberFieldValue(f, 1)).toBe(true)
    expect(validateNumberFieldValue(f, 0)).toBe(false)
    expect(validateNumberFieldValue(f, -3)).toBe(false)
  })
})
