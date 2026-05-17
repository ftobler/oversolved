import { describe, it, expect } from 'vitest'
import { pixelsToClipSpace } from '../pixelsToClipSpace'

describe('pixelsToClipSpace', () => {
  it('1 pixel on a 100x100 viewport == 2/100 clip units on each axis', () => {
    const [dx, dy] = pixelsToClipSpace(1, 100, 100)
    expect(dx).toBeCloseTo(0.02, 10)
    expect(dy).toBeCloseTo(0.02, 10)
  })

  it('8 pixels on a 1920x1080 viewport scales each axis independently', () => {
    const [dx, dy] = pixelsToClipSpace(8, 1920, 1080)
    expect(dx).toBeCloseTo((2 * 8) / 1920, 10)
    expect(dy).toBeCloseTo((2 * 8) / 1080, 10)
  })

  it('clamps the viewport to >= 1 to avoid divide-by-zero', () => {
    const [dx, dy] = pixelsToClipSpace(4, 0, 0)
    expect(dx).toBeCloseTo(8, 10)
    expect(dy).toBeCloseTo(8, 10)
  })

  it('scales linearly with pixel input', () => {
    const [dx1] = pixelsToClipSpace(1, 800, 600)
    const [dx4] = pixelsToClipSpace(4, 800, 600)
    expect(dx4 / dx1).toBeCloseTo(4, 10)
  })
})
