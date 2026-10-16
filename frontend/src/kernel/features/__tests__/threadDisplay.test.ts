// The cosmetic thread's display geometry, pure: one helix per site, laid on the
// bore wall at the thread's pitch, with the frame the helix feature's own math
// would build for the same axis/radius.
import { describe, it, expect } from 'vitest'
import { threadHelices } from '../threadDisplay'

const site = (over: Partial<Parameters<typeof threadHelices>[0][number]> = {}) => ({
  center: [0, 0, 0] as [number, number, number],
  axis: [0, 0, 1] as [number, number, number],
  radius: 2.5,
  length: 10,
  ...over,
})

describe('threadHelices', () => {
  it('samples one helix per site at the bore radius', () => {
    const out = threadHelices([site(), site({ center: [10, 0, 0] })], 1)
    expect(out).toHaveLength(2)
    for (const helix of out) {
      expect(helix.radius).toBe(2.5)
      expect(helix.pitch).toBe(1)
      expect(helix.turns).toBe(10)
      expect(helix.points.length).toBeGreaterThan(10)
      // Every point sits on the bore wall's cylinder.
      for (const p of helix.points) {
        const dx = p[0] - helix.center[0]
        const dy = p[1] - helix.center[1]
        expect(Math.hypot(dx, dy)).toBeCloseTo(2.5, 6)
      }
    }
    expect(out[0].points[0][2]).toBeCloseTo(0, 9)
    expect(out[0].points.at(-1)![2]).toBeCloseTo(10, 6)
  })

  it('keeps one turn when the bore is shorter than the pitch', () => {
    const [helix] = threadHelices([site({ length: 0.3 })], 1)
    expect(helix.turns).toBe(1)
    expect(helix.points.at(-1)![2]).toBeCloseTo(1, 6)
  })

  it('follows the site axis', () => {
    const [helix] = threadHelices([site({ center: [1, 2, 3], axis: [1, 0, 0], length: 4 })], 0.5)
    expect(helix.turns).toBe(8)
    expect(helix.points[0][0]).toBeCloseTo(1, 9)
    expect(helix.points.at(-1)![0]).toBeCloseTo(5, 6)
    // The radial offset stays in the plane perpendicular to the axis.
    for (const p of helix.points) {
      expect(Math.hypot(p[1] - 2, p[2] - 3)).toBeCloseTo(2.5, 6)
    }
  })

  it('refuses a non-positive pitch rather than emitting an empty line', () => {
    expect(() => threadHelices([site()], 0)).toThrow(/pitch must be positive/)
    expect(() => threadHelices([site()], Number.NaN)).toThrow(/pitch must be positive/)
  })
})
