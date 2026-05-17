import { describe, it, expect } from 'vitest'
import { idToRGB, rgbToId, idToRGBNormalized, MAX_ID } from '../idEncoding'

describe('idEncoding', () => {
  it('round-trips sequential ids 0..255', () => {
    for (let id = 0; id <= 255; id++) {
      const [r, g, b] = idToRGB(id)
      expect(rgbToId(r, g, b)).toBe(id)
    }
  })

  it('round-trips boundary values', () => {
    for (const id of [0, 1, 255, 256, 65535, 65536, MAX_ID - 1, MAX_ID]) {
      const [r, g, b] = idToRGB(id)
      expect(rgbToId(r, g, b)).toBe(id)
    }
  })

  it('round-trips 1000 random ids', () => {
    for (let i = 0; i < 1000; i++) {
      const id = Math.floor(Math.random() * (MAX_ID + 1))
      const [r, g, b] = idToRGB(id)
      expect(rgbToId(r, g, b)).toBe(id)
    }
  })

  it('rejects out-of-range ids', () => {
    expect(() => idToRGB(-1)).toThrow()
    expect(() => idToRGB(MAX_ID + 1)).toThrow()
    expect(() => idToRGB(1.5)).toThrow()
  })

  it('normalized form matches integer form / 255', () => {
    const [r, g, b] = idToRGB(0x123456)
    const [rn, gn, bn] = idToRGBNormalized(0x123456)
    expect(rn).toBeCloseTo(r / 255, 10)
    expect(gn).toBeCloseTo(g / 255, 10)
    expect(bn).toBeCloseTo(b / 255, 10)
  })

  it('rgbToId ignores high bits beyond 8 per channel', () => {
    expect(rgbToId(0x1FF, 0, 0)).toBe(rgbToId(0xFF, 0, 0))
  })
})
