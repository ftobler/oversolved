// Pins the render-side Euler triples to the canonical frames. The triples live
// in utils/builtinPlanes.ts rather than being derived from kernel/solverConstants
// (that would invert the utils -> kernel dependency), so this test is what keeps
// the two from drifting: an Euler XYZ rotation applied to the local axes must
// reproduce each builtin frame's x_axis, y_axis and normal.

import { describe, it, expect } from 'vitest'
import { BUILTIN_PLANE_ROTATIONS, DEFAULT_PLANE_SIZE } from '@/utils/builtinPlanes'
import { BUILTIN_PLANES } from '@/kernel/solverConstants'

type Vec3 = [number, number, number]

function rotateXyz(rotation: Vec3, v: Vec3): Vec3 {
  const [rx, ry, rz] = rotation
  const cx = Math.cos(rx), sx = Math.sin(rx)
  const cy = Math.cos(ry), sy = Math.sin(ry)
  const cz = Math.cos(rz), sz = Math.sin(rz)
  // R = Rx * Ry * Rz, the composition three.js uses for an 'XYZ' Euler.
  const m = [
    [cy * cz, -cy * sz, sy],
    [cx * sz + sx * sy * cz, cx * cz - sx * sy * sz, -sx * cy],
    [sx * sz - cx * sy * cz, sx * cz + cx * sy * sz, cx * cy],
  ]
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ]
}

function expectVecClose(actual: Vec3, expected: number[]): void {
  expect(actual[0]).toBeCloseTo(expected[0], 9)
  expect(actual[1]).toBeCloseTo(expected[1], 9)
  expect(actual[2]).toBeCloseTo(expected[2], 9)
}

describe('BUILTIN_PLANE_ROTATIONS', () => {
  it('reproduces every canonical frame from kernel/solverConstants', () => {
    for (const [id, frame] of Object.entries(BUILTIN_PLANES)) {
      const rotation = BUILTIN_PLANE_ROTATIONS[id]
      expect(rotation, `no render rotation for ${id}`).toBeDefined()
      expectVecClose(rotateXyz(rotation, [1, 0, 0]), frame.x_axis as number[])
      expectVecClose(rotateXyz(rotation, [0, 1, 0]), frame.y_axis as number[])
      expectVecClose(rotateXyz(rotation, [0, 0, 1]), frame.normal as number[])
    }
  })
})

describe('DEFAULT_PLANE_SIZE', () => {
  it('is the shared quad edge length', () => {
    expect(DEFAULT_PLANE_SIZE).toBe(100)
  })
})
