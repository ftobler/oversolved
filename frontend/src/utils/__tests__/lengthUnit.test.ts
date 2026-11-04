import { describe, it, expect } from 'vitest'
import {
  LENGTH_UNIT_LABEL,
  LENGTH_UNIT_NAME,
  MM_PER_LENGTH_UNIT,
  importScaleFor,
  isLengthUnit,
  lengthUnitOf,
} from '@/utils/lengthUnit'

// The unit table the kernel, the measurement readout and the export dialog all
// share. The important half is the tolerant read: absent means millimetres,
// which is what every document written before the field means.
describe('document length unit', () => {
  it('labels millimetres as mm and inches as in', () => {
    expect(LENGTH_UNIT_LABEL).toEqual({ mm: 'mm', inch: 'in' })
  })

  it('spells the units out for prose', () => {
    expect(LENGTH_UNIT_NAME).toEqual({ mm: 'millimetres', inch: 'inches' })
  })

  it('carries the scale a file export needs', () => {
    expect(MM_PER_LENGTH_UNIT.mm).toBe(1)
    expect(MM_PER_LENGTH_UNIT.inch).toBeCloseTo(25.4, 12)
  })

  it('reads an absent document as millimetres', () => {
    expect(lengthUnitOf(undefined)).toBe('mm')
    expect(lengthUnitOf(null)).toBe('mm')
    expect(lengthUnitOf('mm')).toBe('mm')
  })

  it('reads inch, and reads a malformed value as millimetres', () => {
    expect(lengthUnitOf('inch')).toBe('inch')
    // The loader refuses these by name; the tolerant read keeps a spec that
    // bypassed the loader from scaling a model by a unit nobody authored.
    expect(lengthUnitOf('in')).toBe('mm')
    expect(lengthUnitOf(25.4)).toBe('mm')
    expect(lengthUnitOf('millimetre')).toBe('mm')
  })

  it('recognises exactly the two stored spellings', () => {
    expect(isLengthUnit('mm')).toBe(true)
    expect(isLengthUnit('inch')).toBe(true)
    expect(isLengthUnit('in')).toBe(false)
    expect(isLengthUnit(undefined)).toBe(false)
    expect(isLengthUnit(1)).toBe(false)
  })

  it('brings a millimetre STEP into an inch document at inch numbers', () => {
    // The reader normalises the file to mm; dividing by 25.4 keeps the physical
    // size and makes the stored numbers inches. mm writes no scale at all.
    expect(importScaleFor('inch')).toBeCloseTo(1 / 25.4, 12)
    expect(importScaleFor('mm')).toBeUndefined()
  })
})
