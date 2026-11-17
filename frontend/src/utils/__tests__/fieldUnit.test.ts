import { describe, it, expect } from 'vitest'
import { fieldAccessibleName, unitLabel, unitName } from '@/utils/fieldUnit'

describe('unitLabel', () => {
  it('follows the document unit for a length', () => {
    expect(unitLabel('length', 'mm')).toBe('mm')
    expect(unitLabel('length', 'inch')).toBe('in')
    // An absent argument is the format's millimetre default, as in the doc.
    expect(unitLabel('length')).toBe('mm')
  })

  it('spells an angle, a count and turns', () => {
    expect(unitLabel('angle', 'inch')).toBe('deg')
    expect(unitLabel('count', 'inch')).toBe('pcs')
    expect(unitLabel('turns', 'inch')).toBe('rev')
  })

  it('shows nothing for a ratio', () => {
    expect(unitLabel('none', 'mm')).toBeNull()
  })
})

describe('unitName', () => {
  it('spells the unit out for an accessible name', () => {
    expect(unitName('length', 'mm')).toBe('millimetres')
    expect(unitName('length', 'inch')).toBe('inches')
    expect(unitName('angle')).toBe('degrees')
    expect(unitName('count')).toBe('pieces')
    expect(unitName('turns')).toBe('revolutions')
    expect(unitName('none')).toBeNull()
  })
})

describe('fieldAccessibleName', () => {
  it('appends the said-out-loud unit to the label', () => {
    expect(fieldAccessibleName('Angle', 'angle')).toBe('Angle, degrees')
    expect(fieldAccessibleName('Diameter', 'length', 'inch')).toBe('Diameter, inches')
  })

  it('leaves a ratio label alone', () => {
    expect(fieldAccessibleName('Factor', 'none')).toBe('Factor')
  })
})
