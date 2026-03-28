import { describe, it, expect } from 'vitest'
import { planeRotationFromTransform } from '../Geometry3D/utils'

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
})
