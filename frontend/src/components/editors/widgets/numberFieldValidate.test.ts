import { describe, it, expect } from 'vitest'
import { validateNumberFieldValue } from './numberFieldValidate'
import { positive, nonNegative, finite, between, expressionRefusal } from '@/utils/core/valueRules'
import type { NumberFieldDef } from './fieldTypes'

function field(over: Partial<NumberFieldDef> = {}): NumberFieldDef {
  return { type: 'number', key: 'count', label: 'Count', ...over }
}

describe('validateNumberFieldValue', () => {
  it('accepts anything when the field declares no constraint', () => {
    expect(validateNumberFieldValue(field(), 2.5)).toBeNull()
    expect(validateNumberFieldValue(field(), -7)).toBeNull()
  })

  it('still defers to the schema validate rule, reason included', () => {
    const f = field({ validate: positive })
    expect(validateNumberFieldValue(f, 3)).toBeNull()
    expect(validateNumberFieldValue(f, 0)).toBe('must be greater than 0')
  })

  it("rejects a fractional value when parse is 'int'", () => {
    const f = field({ parse: 'int', validate: positive })
    expect(validateNumberFieldValue(f, 2)).toBeNull()
    expect(validateNumberFieldValue(f, 2.5)).toBe('must be a whole number')
  })

  it("rejects a non-finite value when parse is 'int'", () => {
    const f = field({ parse: 'int' })
    expect(validateNumberFieldValue(f, NaN)).not.toBeNull()
    expect(validateNumberFieldValue(f, Infinity)).not.toBeNull()
  })

  it("leaves a float field alone when parse is 'float'", () => {
    expect(validateNumberFieldValue(field({ parse: 'float' }), 2.5)).toBeNull()
  })

  it('rejects a value below the declared min', () => {
    const f = field({ min: 1 })
    expect(validateNumberFieldValue(f, 0)).toBe('must be at least 1')
    expect(validateNumberFieldValue(f, 1)).toBeNull()
    expect(validateNumberFieldValue(f, 2)).toBeNull()
  })

  it('rejects NaN when a min is declared', () => {
    expect(validateNumberFieldValue(field({ min: 0 }), NaN)).not.toBeNull()
  })

  it('still enforces min alongside parse and validate, as count_x does', () => {
    const f = field({ parse: 'int', validate: positive, min: 1 })
    expect(validateNumberFieldValue(f, 1)).toBeNull()
    expect(validateNumberFieldValue(f, 0)).not.toBeNull()
    expect(validateNumberFieldValue(f, -3)).not.toBeNull()
  })
})

describe('shared value rules', () => {
  it('each refuses with the same words wherever it is used', () => {
    expect(positive(1)).toBeNull()
    expect(positive(0)).toBe('must be greater than 0')
    expect(nonNegative(0)).toBeNull()
    expect(nonNegative(-1)).toBe('must be 0 or more')
    expect(finite(3)).toBeNull()
    expect(finite(Infinity)).toBe('must be a finite number')
    expect(between(0, 90)(45)).toBeNull()
    expect(between(0, 90)(90)).toBe('must be between 0 and 90')
    expect(between(0, 90)(0)).toBe('must be between 0 and 90')
  })

  it('expressionRefusal evaluates first, then applies the rule', () => {
    expect(expressionRefusal('2+3', positive)).toBeNull()
    expect(expressionRefusal(' 2+/ ', positive)).toBe('cannot evaluate "2+/"')
    expect(expressionRefusal('1-4', positive)).toBe('must be greater than 0')
    expect(expressionRefusal('w*2', positive, { w: 3 })).toBeNull()
  })
})
