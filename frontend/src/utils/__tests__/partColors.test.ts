import { describe, it, expect } from 'vitest'
import { blendWhite, normalizeHexColor } from '@/utils/partColors'

describe('blendWhite', () => {
  it('returns the base color unchanged when factor is 0', () => {
    expect(blendWhite('#FF0000', 0)).toBe('#ff0000')
  })

  it('returns white when factor is 1', () => {
    expect(blendWhite('#000000', 1)).toBe('#ffffff')
  })

  it('blends with default hover blend factor', () => {
    const result = blendWhite('#000000')
    expect(result).toBe('#666666')
  })

  it('blends color channels independently', () => {
    const result = blendWhite('#804020', 0.5)
    expect(result).toBe('#c0a090')
  })
})

describe('normalizeHexColor', () => {
  it('returns null for undefined', () => {
    expect(normalizeHexColor(undefined)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(normalizeHexColor('')).toBeNull()
  })

  it('accepts 6-digit hex with # and converts to uppercase', () => {
    expect(normalizeHexColor('#ff8800')).toBe('#FF8800')
  })

  it('accepts already uppercase 6-digit hex with #', () => {
    expect(normalizeHexColor('#FF8800')).toBe('#FF8800')
  })

  it('returns null for 3-digit hex with #', () => {
    expect(normalizeHexColor('#abc')).toBeNull()
  })

  it('returns null for hex without # prefix', () => {
    expect(normalizeHexColor('ff8800')).toBeNull()
  })

  it('returns null for invalid hex characters', () => {
    expect(normalizeHexColor('#ZZZZZZ')).toBeNull()
  })

  it('trims whitespace before checking', () => {
    expect(normalizeHexColor('  #FF8800  ')).toBe('#FF8800')
  })
})
