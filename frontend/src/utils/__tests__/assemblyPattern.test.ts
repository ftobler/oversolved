// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { canonicalPerp } from '@/utils/mateOrientation'
import { rotateVector, type Vec3 } from '@/utils/transform3d'
import { orderPatternPoses, seedTransformForPose, type PatternPose } from '../assemblyPattern'

function pose(point: Vec3, axis: Vec3 = [0, 1, 0]): PatternPose {
  return { point, axis, x_axis: canonicalPerp(axis) }
}

function ring(count: number, radius: number): PatternPose[] {
  return Array.from({ length: count }, (_, i) => {
    const a = (2 * Math.PI * i) / count
    return pose([radius * Math.cos(a), 3, radius * Math.sin(a)])
  })
}

function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items]
  let state = 12345
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) % 2147483648
    const j = state % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function apply(t: { tx: number; ty: number; tz: number; qx: number; qy: number; qz: number; qw: number }, p: Vec3): Vec3 {
  const r = rotateVector([t.qx, t.qy, t.qz, t.qw], p)
  return [r[0] + t.tx, r[1] + t.ty, r[2] + t.tz]
}

describe('orderPatternPoses', () => {
  it('orders a ring by angle and ignores the input order', () => {
    const holes = ring(7, 20)
    const a = orderPatternPoses(holes)
    const b = orderPatternPoses(shuffled(holes))
    expect(b).toEqual(a)
    // Seven evenly spaced holes visited by angle: every step turns the same
    // way by the same angle, whichever hole the canonical reference starts on.
    const step = (from: PatternPose, to: PatternPose) => {
      const turn = Math.atan2(to.point[2], to.point[0]) - Math.atan2(from.point[2], from.point[0])
      return ((turn % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
    }
    const eachStep = a.map((hole, i) => step(hole, a[(i + 1) % a.length]))
    const forward = (2 * Math.PI) / 7
    const direction = Math.abs(eachStep[0] - forward) < 1e-9 ? forward : 2 * Math.PI - forward
    for (const turn of eachStep) expect(turn).toBeCloseTo(direction, 9)
  })

  it('orders collinear points along their principal direction', () => {
    const row = [3, 0, 2, 1].map(i => pose([i * 10, 0, 5]))
    expect(orderPatternPoses(row).map(h => h.point[0])).toEqual([0, 10, 20, 30])
    expect(orderPatternPoses([...row].reverse()).map(h => h.point[0])).toEqual([0, 10, 20, 30])
  })

  it('keeps a single match and an empty list as they are', () => {
    const only = pose([1, 2, 3])
    expect(orderPatternPoses([only])).toEqual([only])
    expect(orderPatternPoses([])).toEqual([])
  })
})

describe('seedTransformForPose', () => {
  it('lands the local anchor on every hole of a ring', () => {
    const local = { point: [1, 2, 3] as Vec3, axis: [0, 0, 1] as Vec3 }
    for (const hole of ring(7, 20)) {
      const t = seedTransformForPose(local, hole, false)
      const landed = apply(t, local.point)
      for (let i = 0; i < 3; i++) expect(landed[i]).toBeCloseTo(hole.point[i], 9)
      const axis = rotateVector([t.qx, t.qy, t.qz, t.qw], local.axis)
      for (let i = 0; i < 3; i++) expect(axis[i]).toBeCloseTo(hole.axis[i], 9)
    }
  })

  it('points the axis against the hole when flipped, with the roll frames shared', () => {
    const local = { point: [0, 0, 0] as Vec3, axis: [1, 0, 0] as Vec3 }
    const hole = pose([5, 5, 5], [0, 0, 1])
    const t = seedTransformForPose(local, hole, true)
    const q: [number, number, number, number] = [t.qx, t.qy, t.qz, t.qw]
    const axis = rotateVector(q, local.axis)
    expect(axis[2]).toBeCloseTo(-1, 9)
    const x = rotateVector(q, canonicalPerp(local.axis))
    for (let i = 0; i < 3; i++) expect(x[i]).toBeCloseTo(hole.x_axis[i], 9)
  })
})
