import { describe, it, expect } from 'vitest'
import { formatReadout, formatReadouts } from '@/utils/measure/format'
import type { Readout } from '@/utils/measure/rules'

// The one formatter: part and assembly HUDs both render through it, so these
// pin the precision and the unit suffix for every readout kind.

const length: Readout = { kind: 'distance', value: 40, label: 'distance' }

describe('formatReadout', () => {
  it('renders a length with three decimals and the document unit', () => {
    expect(formatReadout(length)).toBe('distance 40.000 mm')
    expect(formatReadout(length, 'inch')).toBe('distance 40.000 in')
  })

  it('renders an angle with one decimal and a degree sign', () => {
    expect(formatReadout({ kind: 'angle', value: 90, label: 'angle' })).toBe('angle 90.0°')
    expect(formatReadout({ kind: 'angle', value: 33.333, label: 'angle' })).toBe('angle 33.3°')
  })

  it('keeps the qualifier the rules chose', () => {
    expect(formatReadout({ kind: 'distance', value: 20, label: 'axis distance' }))
      .toBe('axis distance 20.000 mm')
  })

  it('renders the primary readout before its extras', () => {
    const arc: Readout = {
      kind: 'radius',
      value: 4,
      label: 'radius',
      extra: [{ kind: 'angle', value: 360, label: 'angle' }],
    }
    expect(formatReadouts(arc)).toEqual(['radius 4.000 mm', 'angle 360.0°'])
  })
})
