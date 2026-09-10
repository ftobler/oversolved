import { describe, it, expect } from 'vitest'
import { handleValueFromTravel, roundHandleValue, shouldCommitHandleRelease, handleTailLength, labelOffsetPx, handleColor } from '../featureHandleMath'
import { COLOR_HOVER, COLOR_PREVIEW_EDGE } from '@/utils/core/partColors'

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

describe('handleColor', () => {
  it('matches the preview wireframe pink at rest', () => {
    expect(handleColor(false, false)).toBe(COLOR_PREVIEW_EDGE)
  })

  it('brightens to the hover white while hovered or dragging', () => {
    expect(handleColor(true, false)).toBe(COLOR_HOVER)
    expect(handleColor(false, true)).toBe(COLOR_HOVER)
    // A drag continuing outside the hover zone stays white.
    expect(handleColor(true, true)).toBe(COLOR_HOVER)
  })
})
