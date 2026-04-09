import { describe, it, expect } from 'vitest'
import { detectDrawAlignment } from '../interaction/useAlignmentSnapEffect'

const LAST: [number, number] = [0, 0]

describe('detectDrawAlignment', () => {
  it('returns null when cursor is at the same position as last point', () => {
    expect(detectDrawAlignment([0, 0], LAST)).toBeNull()
  })

  it('returns null when cursor is at exactly 45 degrees (diagonal)', () => {
    expect(detectDrawAlignment([5, 5], LAST)).toBeNull()
  })

  it('returns kinda_horizontal for a nearly horizontal cursor (small positive dy)', () => {
    const result = detectDrawAlignment([5, 0.1], LAST)
    expect(result?.kind).toBe('kinda_horizontal')
    expect(result?.point).toEqual(LAST)
    expect(result?.vertexId).toBe('draw:last')
  })

  it('returns kinda_horizontal for a nearly horizontal cursor (small negative dy)', () => {
    expect(detectDrawAlignment([5, -0.1], LAST)?.kind).toBe('kinda_horizontal')
  })

  it('returns kinda_horizontal when cursor is to the left (180 deg direction)', () => {
    expect(detectDrawAlignment([-5, 0.1], LAST)?.kind).toBe('kinda_horizontal')
  })

  it('returns kinda_vertical for a nearly vertical cursor (small positive dx)', () => {
    const result = detectDrawAlignment([0.1, 5], LAST)
    expect(result?.kind).toBe('kinda_vertical')
  })

  it('returns kinda_vertical for a nearly vertical cursor (negative dy)', () => {
    expect(detectDrawAlignment([0.1, -5], LAST)?.kind).toBe('kinda_vertical')
  })

  it('returns null for a 45-degree diagonal (outside both tolerance bands)', () => {
    expect(detectDrawAlignment([3, 3], LAST)).toBeNull()
  })

  it('returns null for a 30-degree angle (outside both tolerance bands)', () => {
    expect(detectDrawAlignment([5, 2.89], LAST)).toBeNull()
  })

  it('uses drawLastPoint as the reference, not origin', () => {
    const last: [number, number] = [10, 10]
    const result = detectDrawAlignment([15, 10.1], last)
    expect(result?.kind).toBe('kinda_horizontal')
    expect(result?.point).toEqual([10, 10])
  })
})
