import { describe, it, expect } from 'vitest'
import {
  DIAL_MAJOR_TICK_LENGTH, DIAL_RADIUS, DIAL_READOUT_RADIUS, DIAL_TICK_LENGTH,
  dialPoint, dialReadoutPosition, dialSpoke, dialSweepVertices, dialTicks,
  drawnSweep, formatSwingDegrees, nearestTickIndex,
} from '@/utils/angleDialGeometry'
import { GIZMO_AXES, RING_RADIUS } from '@/utils/gizmoPickGeometry'
import type { Vec3 } from '@/utils/transform3d'

const X = GIZMO_AXES[0]
const Y = GIZMO_AXES[1]
const Z = GIZMO_AXES[2]
const TURN = Math.PI * 2
const DEG = Math.PI / 180

function length(p: Vec3): number {
  return Math.hypot(p[0], p[1], p[2])
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

describe('dialPoint', () => {
  it('puts angle zero on the axis u companion, which is what datum is measured from', () => {
    for (const def of GIZMO_AXES) {
      const p = dialPoint(def, 0, 2)
      expect(p).toEqual([def.u[0] * 2, def.u[1] * 2, def.u[2] * 2])
    }
  })

  it('puts a quarter turn on v', () => {
    const p = dialPoint(Z, Math.PI / 2, 1)
    expect(p[0]).toBeCloseTo(Z.v[0], 10)
    expect(p[1]).toBeCloseTo(Z.v[1], 10)
    expect(p[2]).toBeCloseTo(Z.v[2], 10)
  })

  it('stays in the ring plane, never off along the rotation axis', () => {
    for (const def of GIZMO_AXES) {
      for (const a of [0, 0.3, 1.9, -2.4, 7]) {
        expect(dot(dialPoint(def, a, 1.3), def.axis)).toBeCloseTo(0, 10)
      }
    }
  })

  it('keeps the requested radius', () => {
    expect(length(dialPoint(Y, 1.1, 0.4))).toBeCloseTo(0.4, 10)
  })
})

describe('dialTicks', () => {
  it('draws one tick per snap step around the full turn', () => {
    expect(dialTicks(Z)).toHaveLength(24)
  })

  it('marks every quarter turn as major and nothing else', () => {
    const majors = dialTicks(Z).filter(t => t.major)
    expect(majors.map(t => Math.round(t.angle / DEG))).toEqual([0, 90, 180, 270])
  })

  it('hangs ticks inward off the rim rather than spanning the full radius', () => {
    for (const tick of dialTicks(X)) {
      const expected = tick.major ? DIAL_MAJOR_TICK_LENGTH : DIAL_TICK_LENGTH
      expect(length(tick.end)).toBeCloseTo(DIAL_RADIUS, 10)
      expect(length(tick.start)).toBeCloseTo(DIAL_RADIUS - expected, 10)
      expect(expected).toBeLessThan(DIAL_RADIUS / 2)
    }
  })

  it('sits the rim inside the ring tube so the dial tracks RING_RADIUS', () => {
    expect(DIAL_RADIUS).toBeLessThan(RING_RADIUS)
    expect(DIAL_RADIUS).toBeGreaterThan(RING_RADIUS * 0.9)
  })
})

describe('nearestTickIndex', () => {
  it('resolves exact tick bearings to their own index', () => {
    expect(nearestTickIndex(0)).toBe(0)
    expect(nearestTickIndex(15 * DEG)).toBe(1)
    expect(nearestTickIndex(90 * DEG)).toBe(6)
    expect(nearestTickIndex(345 * DEG)).toBe(23)
  })

  it('wraps bearings past a full turn back onto the same ticks', () => {
    expect(nearestTickIndex(TURN)).toBe(0)
    expect(nearestTickIndex(TURN + 30 * DEG)).toBe(2)
    expect(nearestTickIndex(3 * TURN + 90 * DEG)).toBe(6)
  })

  it('wraps negative bearings instead of returning a negative index', () => {
    expect(nearestTickIndex(-15 * DEG)).toBe(23)
    expect(nearestTickIndex(-90 * DEG)).toBe(18)
    expect(nearestTickIndex(-TURN - 15 * DEG)).toBe(23)
  })

  it('rounds a bearing between ticks to the closer one', () => {
    expect(nearestTickIndex(16 * DEG)).toBe(1)
    expect(nearestTickIndex(29 * DEG)).toBe(2)
  })
})

describe('dialSpoke', () => {
  it('runs from the hub out to the rim', () => {
    const [a, b] = dialSpoke(Y, 0.7)
    expect(a).toEqual([0, 0, 0])
    expect(length(b)).toBeCloseTo(DIAL_RADIUS, 10)
  })
})

describe('drawnSweep', () => {
  it('passes ordinary swings straight through', () => {
    expect(drawnSweep(0)).toBe(0)
    expect(drawnSweep(1.2)).toBe(1.2)
    expect(drawnSweep(-1.2)).toBe(-1.2)
  })

  it('saturates at a full turn rather than wrapping to a thin wedge', () => {
    expect(drawnSweep(370 * DEG)).toBeCloseTo(TURN, 10)
    expect(drawnSweep(900 * DEG)).toBeCloseTo(TURN, 10)
  })

  it('saturates negatively too', () => {
    expect(drawnSweep(-370 * DEG)).toBeCloseTo(-TURN, 10)
    expect(drawnSweep(-900 * DEG)).toBeCloseTo(-TURN, 10)
  })

  it('is continuous across the full-turn boundary', () => {
    expect(drawnSweep(359.9 * DEG)).toBeCloseTo(359.9 * DEG, 10)
    expect(drawnSweep(360.1 * DEG) - drawnSweep(359.9 * DEG)).toBeLessThan(0.2 * DEG)
  })
})

describe('dialSweepVertices', () => {
  it('emits whole triangles fanned from the hub', () => {
    const v = dialSweepVertices(Z, 0, Math.PI / 2)
    expect(v.length % 9).toBe(0)
    for (let i = 0; i < v.length; i += 9) {
      expect([v[i], v[i + 1], v[i + 2]]).toEqual([0, 0, 0])
    }
  })

  it('starts on the datum and ends on the live bearing', () => {
    const datum = Math.PI / 2
    const swing = 40 * DEG
    const v = dialSweepVertices(Z, datum, swing)
    const first: Vec3 = [v[3], v[4], v[5]]
    const last: Vec3 = [v[v.length - 3], v[v.length - 2], v[v.length - 1]]
    // Float32Array storage, so the tolerance is float precision, not double.
    for (let i = 0; i < 3; i++) {
      expect(first[i]).toBeCloseTo(dialPoint(Z, datum, DIAL_RADIUS)[i], 6)
      expect(last[i]).toBeCloseTo(dialPoint(Z, datum + swing, DIAL_RADIUS)[i], 6)
    }
  })

  it('fans backward for a negative swing rather than the long way round', () => {
    const v = dialSweepVertices(Z, 0, -40 * DEG)
    const last: Vec3 = [v[v.length - 3], v[v.length - 2], v[v.length - 1]]
    const expected = dialPoint(Z, -40 * DEG, DIAL_RADIUS)
    for (let i = 0; i < 3; i++) expect(last[i]).toBeCloseTo(expected[i], 6)
  })

  it('closes into a full disc once the swing passes a turn', () => {
    const v = dialSweepVertices(Z, 0, 400 * DEG)
    const last: Vec3 = [v[v.length - 3], v[v.length - 2], v[v.length - 1]]
    const start = dialPoint(Z, 0, DIAL_RADIUS)
    for (let i = 0; i < 3; i++) expect(last[i]).toBeCloseTo(start[i], 6)
  })

  it('still emits a triangle for a zero swing so the mesh is never empty', () => {
    expect(dialSweepVertices(Z, 0, 0).length).toBe(9)
  })

  it('keeps every vertex in the ring plane', () => {
    const v = dialSweepVertices(X, 1.0, 2.0)
    for (let i = 0; i < v.length; i += 3) {
      expect(dot([v[i], v[i + 1], v[i + 2]], X.axis)).toBeCloseTo(0, 10)
    }
  })

  it('scales its segment count with the sweep, so a big wedge is not coarser', () => {
    const small = dialSweepVertices(Z, 0, 10 * DEG).length
    const big = dialSweepVertices(Z, 0, 200 * DEG).length
    expect(big).toBeGreaterThan(small * 10)
  })
})

describe('dialReadoutPosition', () => {
  it('hangs outside the rim so the fill never runs under it', () => {
    expect(length(dialReadoutPosition(Z, 0, Math.PI / 2))).toBeCloseTo(DIAL_READOUT_RADIUS, 10)
    expect(DIAL_READOUT_RADIUS).toBeGreaterThan(RING_RADIUS)
  })

  it('bisects the drawn sweep', () => {
    const p = dialReadoutPosition(Z, 0, Math.PI / 2)
    const expected = dialPoint(Z, Math.PI / 4, DIAL_READOUT_RADIUS)
    for (let i = 0; i < 3; i++) expect(p[i]).toBeCloseTo(expected[i], 10)
  })

  it('bisects the clamped sweep, not the unbounded one, when past a turn', () => {
    const p = dialReadoutPosition(Z, 0, 900 * DEG)
    const expected = dialPoint(Z, Math.PI, DIAL_READOUT_RADIUS)
    for (let i = 0; i < 3; i++) expect(p[i]).toBeCloseTo(expected[i], 10)
  })
})

describe('formatSwingDegrees', () => {
  it('reads a snapped step as a round number', () => {
    expect(formatSwingDegrees(15 * DEG)).toBe('15.0°')
    expect(formatSwingDegrees(90 * DEG)).toBe('90.0°')
  })

  it('signs negative swings', () => {
    expect(formatSwingDegrees(-45 * DEG)).toBe('-45.0°')
  })

  it('reports the true total past a full turn rather than the drawn clamp', () => {
    expect(formatSwingDegrees(725 * DEG)).toBe('725.0°')
    expect(formatSwingDegrees(-400 * DEG)).toBe('-400.0°')
  })

  it('never shows a signed zero', () => {
    expect(formatSwingDegrees(-0.0001)).toBe('0.0°')
    expect(formatSwingDegrees(0)).toBe('0.0°')
  })

  it('keeps one decimal for free motion', () => {
    expect(formatSwingDegrees(12.34 * DEG)).toBe('12.3°')
  })
})
