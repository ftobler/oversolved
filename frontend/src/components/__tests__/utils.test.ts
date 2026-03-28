import { describe, it, expect } from 'vitest'
import { planeRotationFromTransform, planeRotation } from '../Geometry3D/utils'

// 5h: planeRotationFromTransform

describe('planeRotationFromTransform', () => {
  it('converts identity rotation to zero Euler angles', () => {
    const t = { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], origin: [0, 0, 0] }
    const euler = planeRotationFromTransform(t)
    expect(euler[0]).toBeCloseTo(0)
    expect(euler[1]).toBeCloseTo(0)
    expect(euler[2]).toBeCloseTo(0)
  })

  it('converts top-plane rotation to non-zero Euler angles', () => {
    // Top plane: x_axis=[1,0,0], y_axis=[0,0,-1], normal=[0,1,0]
    const t = { rotation: [1, 0, 0, 0, 0, -1, 0, 1, 0], origin: [0, 0, 0] }
    const euler = planeRotationFromTransform(t)
    // Should not be all zeros (top plane is rotated -90° around X)
    const isIdentity = Math.abs(euler[0]) < 1e-6 && Math.abs(euler[1]) < 1e-6 && Math.abs(euler[2]) < 1e-6
    expect(isIdentity).toBe(false)
  })

  it('round-trips front-plane rotation (identity)', () => {
    const t = { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], origin: [5, 3, 0] }
    const euler = planeRotationFromTransform(t)
    expect(euler[0]).toBeCloseTo(0)
    expect(euler[1]).toBeCloseTo(0)
    expect(euler[2]).toBeCloseTo(0)
  })

  it('converts right-plane rotation to non-identity Euler angles', () => {
    // Right plane: x_axis=[0,0,-1], y_axis=[0,1,0], normal=[1,0,0]
    const t = { rotation: [0, 0, -1, 0, 1, 0, 1, 0, 0], origin: [0, 0, 0] }
    const euler = planeRotationFromTransform(t)
    const isIdentity = Math.abs(euler[0]) < 1e-6 && Math.abs(euler[1]) < 1e-6 && Math.abs(euler[2]) < 1e-6
    expect(isIdentity).toBe(false)
  })
})

// planeRotation (builtin lookup)
describe('planeRotation', () => {
  it('returns [0,0,0] for front plane', () => {
    const r = planeRotation('@builtin_plane_front')
    expect(r[0]).toBeCloseTo(0)
    expect(r[1]).toBeCloseTo(0)
    expect(r[2]).toBeCloseTo(0)
  })

  it('returns non-zero for top plane', () => {
    const r = planeRotation('@builtin_plane_top')
    const isIdentity = Math.abs(r[0]) < 1e-6 && Math.abs(r[1]) < 1e-6 && Math.abs(r[2]) < 1e-6
    expect(isIdentity).toBe(false)
  })

  it('returns non-zero for right plane', () => {
    const r = planeRotation('@builtin_plane_right')
    const isIdentity = Math.abs(r[0]) < 1e-6 && Math.abs(r[1]) < 1e-6 && Math.abs(r[2]) < 1e-6
    expect(isIdentity).toBe(false)
  })

  it('returns [0,0,0] for undefined', () => {
    const r = planeRotation(undefined)
    expect(r).toEqual([0, 0, 0])
  })

  it('returns [0,0,0] for an unrecognised derived-face query', () => {
    const r = planeRotation('?3;@sketch0abc:face')
    expect(r).toEqual([0, 0, 0])
  })
})
