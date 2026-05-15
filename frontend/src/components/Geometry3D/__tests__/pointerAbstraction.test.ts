import { describe, it, expect } from 'vitest'
import { makeSanitizedEvent, screenPixelDistance, isPureClick, CLICK_THRESHOLD_PX } from '@/components/Geometry3D/pointerAbstraction'

describe('makeSanitizedEvent', () => {
  it('returns event when local z is within plane (|z| <= 1)', () => {
    const result = makeSanitizedEvent([3, 4, 0.5], [100, 200])
    expect(result).not.toBeNull()
    expect(result?.localPoint).toEqual([3, 4])
    expect(result?.clientPoint).toEqual([100, 200])
  })

  it('returns event when local z is exactly 0', () => {
    expect(makeSanitizedEvent([1, 2, 0], [0, 0])).not.toBeNull()
  })

  it('returns event when local z is exactly 1', () => {
    expect(makeSanitizedEvent([1, 2, 1], [0, 0])).not.toBeNull()
  })

  it('returns null when local z exceeds 1 (off-plane hit)', () => {
    expect(makeSanitizedEvent([1, 2, 1.5], [0, 0])).toBeNull()
  })

  it('returns null when local z is negative and exceeds -1', () => {
    expect(makeSanitizedEvent([1, 2, -1.5], [0, 0])).toBeNull()
  })

  it('discards z component in localPoint', () => {
    const result = makeSanitizedEvent([7, 8, 0.1], [50, 60])
    expect(result?.localPoint).toEqual([7, 8])
  })
})

describe('screenPixelDistance', () => {
  it('returns 0 for identical points', () => {
    expect(screenPixelDistance([5, 5], [5, 5])).toBe(0)
  })

  it('Pythagorean 3-4-5 triangle', () => {
    expect(screenPixelDistance([0, 0], [3, 4])).toBeCloseTo(5)
  })

  it('horizontal distance', () => {
    expect(screenPixelDistance([0, 0], [10, 0])).toBeCloseTo(10)
  })

  it('vertical distance', () => {
    expect(screenPixelDistance([0, 0], [0, 7])).toBeCloseTo(7)
  })
})

describe('isPureClick', () => {
  it('returns true when points are identical (distance = 0)', () => {
    expect(isPureClick([100, 200], [100, 200])).toBe(true)
  })

  it('returns true when distance is below threshold', () => {
    const d = CLICK_THRESHOLD_PX - 1
    expect(isPureClick([0, 0], [d, 0])).toBe(true)
  })

  it('returns false when distance equals threshold', () => {
    expect(isPureClick([0, 0], [CLICK_THRESHOLD_PX, 0])).toBe(false)
  })

  it('returns false when distance exceeds threshold', () => {
    expect(isPureClick([0, 0], [CLICK_THRESHOLD_PX + 5, 0])).toBe(false)
  })
})
