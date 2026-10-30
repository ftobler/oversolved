import { describe, expect, it } from 'vitest'
import { seedAssembly } from '../assemblySeed'
import type { MateWireRecord } from '../solveAssembly'
import { canonicalPerp } from '@/utils/mateOrientation'
import { rotateVector, type Quat, type Vec3 } from '@/utils/transform3d'

function record(over: Partial<MateWireRecord> & Pick<MateWireRecord, 'bodyA' | 'bodyB'>): MateWireRecord {
  const axisA = over.axisA ?? [0, 0, 1]
  const axisB = over.axisB ?? [0, 0, 1]
  return {
    kindCode: 0, anchorKindA: 0, anchorKindB: 0,
    pointA: [0, 0, 0], pointB: [0, 0, 0], axisA, axisB,
    flip: false, offset: [0, 0, 0], ratio: 1, radius: 0, angle: 0,
    perpA: canonicalPerp(axisA), perpB: canonicalPerp(axisB), weight: 1,
    ...over,
  }
}

function params(poses: [Vec3, Quat][]): Float64Array {
  return Float64Array.from(poses.flatMap(([t, q]) => [...t, ...q]))
}

const ID: Quat = [0, 0, 0, 1]
const pose = (p: Float64Array, i: number) => ({
  t: [p[i * 7], p[i * 7 + 1], p[i * 7 + 2]] as Vec3,
  q: [p[i * 7 + 3], p[i * 7 + 4], p[i * 7 + 5], p[i * 7 + 6]] as Quat,
})
const worldPoint = (p: Float64Array, i: number, v: Vec3): Vec3 => {
  const { t, q } = pose(p, i)
  const r = rotateVector(q, v)
  return [r[0] + t[0], r[1] + t[1], r[2] + t[2]]
}
const worldDir = (p: Float64Array, i: number, v: Vec3): Vec3 => rotateVector(pose(p, i).q, v)

describe('seedAssembly', () => {
  it('places a face-to-face weld from an identity seed', () => {
    const p = params([[[0, 0, 0], ID], [[0, 0, 0], ID]])
    const m = record({ bodyA: 0, bodyB: 1, flip: true, pointA: [0, 0, 5], pointB: [0, 0, 0] })
    const seeded = seedAssembly(p, Uint8Array.of(0b01), [m])
    const axis = worldDir(seeded, 1, [0, 0, 1])
    expect(axis[2]).toBeCloseTo(-1, 9)
    const pb = worldPoint(seeded, 1, [0, 0, 0])
    expect(pb[0]).toBeCloseTo(0, 9)
    expect(pb[2]).toBeCloseTo(5, 9)
  })

  it('follows a fixed chain cube-rail-cube to the exact poses', () => {
    const p = params([[[0, 0, 0], ID], [[0, 0, 0], ID], [[0, 0, 0], ID]])
    const m1 = record({ bodyA: 0, bodyB: 1, flip: true, pointA: [0, 0, 5] })
    const m2 = record({ bodyA: 1, bodyB: 2, flip: true, pointA: [0, 0, 8] })
    const seeded = seedAssembly(p, Uint8Array.of(0b001), [m1, m2])
    const end = worldPoint(seeded, 2, [0, 0, 0])
    // Body 1 is turned over at z = 5; its +8 local z points back to z = -3.
    expect(end[2]).toBeCloseTo(5 - 8, 9)
    expect(worldDir(seeded, 2, [0, 0, 1])[2]).toBeCloseTo(1, 9)
  })

  it('applies the authored angle as the roll', () => {
    const p = params([[[0, 0, 0], ID], [[0, 0, 0], ID]])
    const m = record({ bodyA: 0, bodyB: 1, angle: Math.PI / 2 })
    const seeded = seedAssembly(p, Uint8Array.of(0b01), [m])
    const xb = worldDir(seeded, 1, m.perpB)
    const xa = m.perpA
    const crossZ = xa[0] * xb[1] - xa[1] * xb[0]
    expect(crossZ).toBeCloseTo(1, 9)
  })

  it('places from the B side by swapping roles', () => {
    const p = params([[[0, 0, 0], ID], [[0, 0, 0], ID]])
    const m = record({ bodyA: 1, bodyB: 0, flip: true, pointB: [0, 0, 4] })
    const seeded = seedAssembly(p, Uint8Array.of(0b01), [m])
    expect(worldDir(seeded, 1, [0, 0, 1])[2]).toBeCloseTo(-1, 9)
    expect(worldPoint(seeded, 1, [0, 0, 0])[2]).toBeCloseTo(4, 9)
  })

  it('aligns a rotating mate by the minimal rotation and keeps the seed roll', () => {
    const half = Math.sin(Math.PI / 8)
    const q: Quat = [0, 0, half, Math.cos(Math.PI / 8)]  // 45 deg about z
    const p = params([[[0, 0, 0], ID], [[9, 9, 9], q]])
    const m = record({ kindCode: 4, bodyA: 0, bodyB: 1, axisA: [1, 0, 0], axisB: [0, 0, 1], pointA: [1, 2, 3] })
    const seeded = seedAssembly(p, Uint8Array.of(0b01), [m])
    const axis = worldDir(seeded, 1, [0, 0, 1])
    expect(axis[0]).toBeCloseTo(1, 9)
    const pb = worldPoint(seeded, 1, [0, 0, 0])
    expect(pb[0]).toBeCloseTo(1, 9)
    expect(pb[1]).toBeCloseTo(2, 9)
    expect(pb[2]).toBeCloseTo(3, 9)
  })

  it('returns a seed that already satisfies its mate bit-exact', () => {
    const q: Quat = [0.1, 0.2, 0.3, Math.sqrt(1 - 0.14)]
    const p = params([[[0, 0, 0], ID], [[0.3, 0.2, 0.1], q]])
    const base = record({ bodyA: 0, bodyB: 1, pointB: [0, 0, 0] })
    // Build a mate this exact pose satisfies: A's anchors are B's world ones.
    const m = record({
      bodyA: 0, bodyB: 1, kindCode: 1,
      pointA: worldPoint(p, 1, base.pointB), pointB: base.pointB,
    })
    const seeded = seedAssembly(p, Uint8Array.of(0b01), [m])
    expect(Array.from(seeded)).toEqual(Array.from(p))
  })

  it('places each part by the first reaching mate and leaves the cycle edge to the solver', () => {
    const p = params([[[0, 0, 0], ID], [[0, 0, 0], ID], [[0, 0, 0], ID]])
    const first = record({ kindCode: 1, bodyA: 0, bodyB: 1, pointA: [1, 0, 0] })
    const second = record({ kindCode: 1, bodyA: 0, bodyB: 2, pointA: [0, 2, 0] })
    const cycle = record({ kindCode: 1, bodyA: 1, bodyB: 2, pointA: [7, 7, 7] })
    const seeded = seedAssembly(p, Uint8Array.of(0b001), [first, second, cycle])
    expect(worldPoint(seeded, 1, [0, 0, 0])).toEqual([1, 0, 0])
    expect(worldPoint(seeded, 2, [0, 0, 0])).toEqual([0, 2, 0])
  })

  it('ignores weighted drag objectives and unplaceable kinds', () => {
    const p = params([[[0, 0, 0], ID], [[3, 0, 0], ID]])
    const drag = record({ kindCode: 1, bodyA: 0, bodyB: 1, weight: 0.01 })
    const parallel = record({ kindCode: 2, bodyA: 0, bodyB: 1 })
    const seeded = seedAssembly(p, Uint8Array.of(0b01), [drag, parallel])
    expect(Array.from(seeded)).toEqual(Array.from(p))
  })

  it('treats the grounded frame as a root and never moves a grounded body', () => {
    const p = params([[[1, 2, 3], ID], [[0, 0, 0], ID]])
    const m = record({ bodyA: 0, bodyB: 1, flip: true })
    const seeded = seedAssembly(p, Uint8Array.of(0b01), [m])
    expect(Array.from(seeded.slice(0, 7))).toEqual(Array.from(p.slice(0, 7)))
    expect(worldPoint(seeded, 1, [0, 0, 0])).toEqual([1, 2, 3])
  })

  it('does not mutate its input', () => {
    const p = params([[[0, 0, 0], ID], [[0, 0, 0], ID]])
    const copy = Float64Array.from(p)
    seedAssembly(p, Uint8Array.of(0b01), [record({ bodyA: 0, bodyB: 1, flip: true })])
    expect(Array.from(p)).toEqual(Array.from(copy))
  })
})
