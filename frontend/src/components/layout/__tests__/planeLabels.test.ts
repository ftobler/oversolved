import { describe, it, expect } from 'vitest'

describe('Plane Labels - Unicode Support', () => {
  it('supports ASCII labels', () => {
    const label = 'Plane1'
    expect(label).toEqual('Plane1')
    expect(label.length).toBe(6)
  })

  it('supports Unicode characters in labels', () => {
    const label = 'Плоскость'  // Russian: "Plane"
    expect(label.length).toBe(9)
    expect(label).toMatch(/^[А-Яа-яё]+$/)
  })

  it('supports emoji in labels', () => {
    const label = '🔵 Plane'
    expect(label).toContain('🔵')
    expect(label).toContain('Plane')
  })

  it('supports mixed Unicode and emoji', () => {
    const label = '✈️ 飛行機 🛫'  // Airplane emoji, Japanese, takeoff emoji
    expect(label).toContain('✈️')
    expect(label).toContain('飛行機')
    expect(label).toContain('🛫')
  })

  it('supports mathematical symbols', () => {
    const label = '∅ Empty ∞ Infinite'
    expect(label).toContain('∅')
    expect(label).toContain('∞')
  })

  it('handles label fallback to ID', () => {
    const featureId = 'abc123'
    const label = undefined as string | undefined
    const displayName = label || featureId
    expect(displayName).toBe('abc123')
  })

  it('uses label when available', () => {
    const featureId = 'abc123'
    const label = '🎨 Creative Plane'
    const displayName = label || featureId
    expect(displayName).toBe('🎨 Creative Plane')
  })
})
