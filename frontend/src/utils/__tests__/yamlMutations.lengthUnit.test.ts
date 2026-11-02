import { describe, it, expect } from 'vitest'
import { applySetLengthUnit } from '@/utils/yamlMutations'
import type { PartDoc } from '@/types/cad'

// The applier never converts a stored number: the unit says what the numbers
// already mean. Millimetres is the format's default and lives as the absence of
// the key, so leaving inches is a byte-identical move back to the old spelling.
describe('applySetLengthUnit', () => {
  const doc = (): PartDoc => ({
    version: 1,
    kind: 'part',
    features: [{ id: 'sk1', kind: 'sketch', initial: { l1: [0, 0, 0.5, 0] } }],
  })

  it('sets an inch document', () => {
    const d = doc()
    applySetLengthUnit(d, 'inch')
    expect(d.length_unit).toBe('inch')
  })

  it('leaves the authored numbers untouched when the unit is set', () => {
    const d = doc()
    const before = JSON.stringify(d.features)
    applySetLengthUnit(d, 'inch')
    expect(JSON.stringify(d.features)).toBe(before)
  })

  it('stores millimetres as the absence of the key', () => {
    const d = doc()
    applySetLengthUnit(d, 'inch')
    applySetLengthUnit(d, 'mm')
    expect('length_unit' in d).toBe(false)
  })

  it('is byte-identical for a document that never left millimetres', () => {
    const d = doc()
    const before = JSON.stringify(d)
    applySetLengthUnit(d, 'mm')
    expect(JSON.stringify(d)).toBe(before)
  })
})
