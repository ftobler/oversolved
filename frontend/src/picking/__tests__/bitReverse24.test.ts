import { describe, it, expect } from 'vitest'
import { bitReverse24 } from '../bitReverse24'

describe('bitReverse24', () => {
  it('reverses single-bit inputs across the 24-bit range', () => {
    for (let i = 0; i < 24; i++) {
      const input = 1 << i
      const expected = 1 << (23 - i)
      expect(bitReverse24(input)).toBe(expected >>> 0)
    }
  })

  it('is bijective over a sampled subset of [0, 2^24)', () => {
    const seen = new Map<number, number>()
    // Sample 1000 distinct inputs deterministically.
    for (let i = 0; i < 1000; i++) {
      const input = (i * 2654435761) & 0xFFFFFF
      const out = bitReverse24(input)
      const previous = seen.get(out)
      if (previous !== undefined) {
        expect(previous).toBe(input)  // identical input would explain identical output
      }
      seen.set(out, input)
      expect(out).toBeLessThan(1 << 24)
      // Inverse: reversing again returns the input.
      expect(bitReverse24(out)).toBe(input)
    }
  })

  it('maps sequential small ids to maximally separated outputs', () => {
    // 0..15 should land in the top six bits, so each step is >= 2^18.
    for (let i = 0; i < 15; i++) {
      const a = bitReverse24(i)
      const b = bitReverse24(i + 1)
      expect(Math.abs(a - b)).toBeGreaterThanOrEqual(1 << 18)
    }
  })

  it('handles boundary inputs', () => {
    expect(bitReverse24(0)).toBe(0)
    expect(bitReverse24(0xFFFFFF)).toBe(0xFFFFFF)
    expect(bitReverse24(0x800000)).toBe(1)
    expect(bitReverse24(0xAAAAAA)).toBe(0x555555)
  })
})
