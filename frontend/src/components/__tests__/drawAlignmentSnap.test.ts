import { describe, it, expect } from 'vitest'
import { ALIGNMENT_TOLERANCE_DIST } from '@/registry'
import { detectDrawAlignment } from '@/components/interaction/useAlignmentSnapEffect'

const LAST: [number, number] = [0, 0]
const TOL = ALIGNMENT_TOLERANCE_DIST  // screen pixels; passed as world tolerance for testing

describe('detectDrawAlignment', () => {
  it('returns null when cursor is at the same position as last point', () => {
    expect(detectDrawAlignment([0, 0], LAST, TOL)).toBeNull()
  })

  it('returns kinda_horizontal for a nearly horizontal cursor (small positive dy)', () => {
    const result = detectDrawAlignment([5, 0.1], LAST, TOL)
    expect(result?.kind).toBe('kinda_horizontal')
    expect(result?.point).toEqual(LAST)
    expect(result?.vertexId).toBe('draw:last')
  })

  it('returns kinda_horizontal for a nearly horizontal cursor (small negative dy)', () => {
    expect(detectDrawAlignment([5, -0.1], LAST, TOL)?.kind).toBe('kinda_horizontal')
  })

  it('returns kinda_horizontal when cursor is to the left (180 deg direction)', () => {
    expect(detectDrawAlignment([-5, 0.1], LAST, TOL)?.kind).toBe('kinda_horizontal')
  })

  it('returns kinda_vertical for a nearly vertical cursor (small positive dx)', () => {
    const result = detectDrawAlignment([0.1, 5], LAST, TOL)
    expect(result?.kind).toBe('kinda_vertical')
  })

  it('returns kinda_vertical for a nearly vertical cursor (negative dy)', () => {
    expect(detectDrawAlignment([0.1, -5], LAST, TOL)?.kind).toBe('kinda_vertical')
  })

  it('returns null for a 45-degree diagonal (outside both tolerance bands)', () => {
    expect(detectDrawAlignment([3, 3], LAST, TOL)).toBeNull()
  })

  it('returns null for a 30-degree angle (outside both tolerance bands)', () => {
    expect(detectDrawAlignment([5, 2.89], LAST, TOL)).toBeNull()
  })

  it('uses drawLastPoint as the reference, not origin', () => {
    const last: [number, number] = [10, 10]
    const result = detectDrawAlignment([15, 10.1], last, TOL)
    expect(result?.kind).toBe('kinda_horizontal')
    expect(result?.point).toEqual([10, 10])
  })
})
