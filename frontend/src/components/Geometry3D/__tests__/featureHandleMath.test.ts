import { describe, it, expect } from 'vitest'
import { closestAxisParam, handleValueFromTravel, roundHandleValue, shouldCommitHandleRelease, handleTailLength, labelOffsetPx } from '../featureHandleMath'

describe('closestAxisParam', () => {
  it('hits the exact axis point when the ray crosses the axis', () => {
    // Axis +Z from origin; ray shooting -X passes through (0, 0, 4).
    const t = closestAxisParam([10, 0, 4], [-1, 0, 0], [0, 0, 0], [0, 0, 1])
    expect(t).toBeCloseTo(4, 9)
  })

  it('is signed along the axis direction', () => {
    const t = closestAxisParam([10, 0, -3], [-1, 0, 0], [0, 0, 0], [0, 0, 1])
    expect(t).toBeCloseTo(-3, 9)
  })

  it('uses the closest point for a skew ray', () => {
    // Ray parallel to X at y=5, z=7: closest axis point is z=7 regardless of y offset.
    const t = closestAxisParam([10, 5, 7], [-1, 0, 0], [0, 0, 0], [0, 0, 1])
    expect(t).toBeCloseTo(7, 9)
  })

  it('offsets by the axis origin', () => {
    const t = closestAxisParam([10, 0, 4], [-1, 0, 0], [0, 0, 1], [0, 0, 1])
    expect(t).toBeCloseTo(3, 9)
  })

  it('returns null when the ray is parallel to the axis (axis end-on)', () => {
    expect(closestAxisParam([5, 5, 0], [0, 0, 1], [0, 0, 0], [0, 0, 1])).toBeNull()
  })

  it('handles a diagonal camera ray (orthographic-style)', () => {
    // Axis +X; ray direction (-1,-1,-1)/sqrt(3) from (6,4,4): the closest
    // point on the axis to that line is x = 2 (offset perpendicular splits
    // evenly between y and z).
    const s = 1 / Math.sqrt(3)
    const t = closestAxisParam([6, 4, 4], [-s, -s, -s], [0, 0, 0], [1, 0, 0])
    expect(t).toBeCloseTo(2, 9)
  })

  it('accepts a non-unit ray direction (parameter is in axisDir units)', () => {
    // Same geometry as the first test but ray direction is [-2,0,0] (len 2).
    // The closest-point parameter along the axis must be unchanged because
    // it is expressed in axisDir (unit) units, not rayDir units.
    const t = closestAxisParam([10, 0, 4], [-2, 0, 0], [0, 0, 0], [0, 0, 1])
    expect(t).toBeCloseTo(4, 9)
  })

  it('returns null for a zero-length axis (degenerate descriptor)', () => {
    expect(closestAxisParam([10, 0, 4], [-1, 0, 0], [0, 0, 0], [0, 0, 0])).toBeNull()
  })

  it('returns null for a zero-length ray (no cursor direction)', () => {
    expect(closestAxisParam([10, 0, 4], [0, 0, 0], [0, 0, 0], [0, 0, 1])).toBeNull()
  })
})

describe('handleValueFromTravel', () => {
  it('adds travel scaled by unitScale', () => {
    expect(handleValueFromTravel(10, 5, 1, 0.01)).toBeCloseTo(15)
    // Symmetric extrude: half a world unit per distance unit.
    expect(handleValueFromTravel(10, 5, 0.5, 0.01)).toBeCloseTo(20)
  })

  it('clamps to min', () => {
    expect(handleValueFromTravel(3, -10, 1, 0.01)).toBe(0.01)
  })

  it('clamps to max when given', () => {
    expect(handleValueFromTravel(350, 100, 1, 0.01, 360)).toBe(360)
    expect(handleValueFromTravel(350, 100, 1, 0.01)).toBeCloseTo(450)
  })

  it('holds the start value when unitScale is zero (degenerate symmetric extrude)', () => {
    expect(handleValueFromTravel(5, 10, 0, 0.01)).toBe(5)
    expect(handleValueFromTravel(5, -10, 0, 0.01, 100)).toBe(5)
  })
})

describe('shouldCommitHandleRelease', () => {
  it('commits the rounded value when it differs from the start by >= 0.01', () => {
    expect(shouldCommitHandleRelease(10, 12.345)).toBe(12.35)
  })

  it('skips commits where the rounded value equals the start (sub-centesimal micro-drag)', () => {
    expect(shouldCommitHandleRelease(10, 10.004)).toBeNull()
    expect(shouldCommitHandleRelease(10.005, 10.009)).toBeNull()
  })

  it('commits on a genuine opposite-direction drag', () => {
    expect(shouldCommitHandleRelease(10, 9.5)).toBe(9.5)
  })

  it('treats values already equal to start as a no-op', () => {
    expect(shouldCommitHandleRelease(7, 7)).toBeNull()
  })
})

describe('roundHandleValue', () => {
  it('rounds to two decimals', () => {
    expect(roundHandleValue(3.14159)).toBe(3.14)
    expect(roundHandleValue(2.005)).toBeCloseTo(2.01, 10)
    expect(roundHandleValue(-1.239)).toBe(-1.24)
  })
})

describe('handleTailLength', () => {
  it('spans the full feature for a linear handle (anchor to feature origin)', () => {
    expect(handleTailLength('linear', 25, 1)).toBe(25)
  })

  it('applies the unit scale (symmetric extrude: grab face at distance/2)', () => {
    expect(handleTailLength('linear', 20, 0.5)).toBe(10)
  })

  it('never goes negative', () => {
    expect(handleTailLength('linear', -5, 1)).toBe(0)
  })

  it('gives angular handles no tail (a straight shaft would misrepresent the arc)', () => {
    expect(handleTailLength('angular', 180, 2)).toBe(0)
  })
})

describe('labelOffsetPx', () => {
  it('offsets along the projected arrow direction with the box support term', () => {
    // Arrow pointing screen-right: label center moves right by gap + halfW.
    expect(labelOffsetPx([1, 0], 40, 9, 8)).toEqual([48, 0])
    // Arrow pointing screen-up (y negative): label center moves up by gap + halfH.
    const [ox, oy] = labelOffsetPx([0, -2], 40, 9, 8)
    expect(ox).toBeCloseTo(0, 9)
    expect(oy).toBeCloseTo(-17, 9)
  })

  it('normalizes the direction (magnitude does not change the offset)', () => {
    expect(labelOffsetPx([5, 0], 40, 9, 8)).toEqual(labelOffsetPx([1, 0], 40, 9, 8))
  })

  it('mixes width and height support for a diagonal arrow', () => {
    const s = Math.SQRT1_2
    const [ox, oy] = labelOffsetPx([1, 1], 40, 9, 8)
    const support = 40 * s + 9 * s
    expect(ox).toBeCloseTo(s * (8 + support), 9)
    expect(oy).toBeCloseTo(s * (8 + support), 9)
  })

  it('falls back to above-the-tip when the arrow is seen end-on', () => {
    expect(labelOffsetPx([0, 0], 40, 9, 8)).toEqual([0, -17])
  })
})
