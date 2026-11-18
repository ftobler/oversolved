import { describe, it, expect } from 'vitest'
import { formatReadout, formatReadoutHud, formatReadouts } from '@/utils/measure/format'
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

  it('renders area and volume with their squared and cubed unit', () => {
    expect(formatReadout({ kind: 'area', value: 1200, label: 'area' })).toBe('area 1200.000 mm²')
    expect(formatReadout({ kind: 'volume', value: 8000, label: 'volume' }, 'inch'))
      .toBe('volume 8000.000 in³')
  })

  it('appends a qualifier the readout carries', () => {
    expect(formatReadout({ kind: 'distance', value: 8, label: 'distance', note: 'on extension' }))
      .toBe('distance 8.000 mm (on extension)')
  })

  it('splits the primary and two extras from the rest of the HUD', () => {
    const readout: Readout = {
      kind: 'distance',
      value: 5,
      label: 'distance',
      extra: [
        { kind: 'distance', value: 3, label: 'dx' },
        { kind: 'distance', value: 4, label: 'dy' },
        { kind: 'distance', value: 0, label: 'dz' },
      ],
    }
    expect(formatReadoutHud(readout)).toEqual({
      lines: ['distance 5.000 mm', 'dx 3.000 mm', 'dy 4.000 mm'],
      more: ['dz 0.000 mm'],
    })
  })
})
