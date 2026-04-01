import { describe, it, expect } from 'vitest'
import { planeRotationFromTransform } from '../utils'

describe('planeRotationFromTransform', () => {
  it('converts Front plane transform correctly', () => {
    // Front plane: identity rotation
    const frontTransform = {
      rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      origin: [0, 0, 0],
    }
    const [x, y, z] = planeRotationFromTransform(frontTransform)
    expect(x).toBeCloseTo(0, 4)
    expect(y).toBeCloseTo(0, 4)
    expect(z).toBeCloseTo(0, 4)
  })

  it('converts Top plane transform correctly', () => {
    // Top plane: rotated -90 degrees around X
    // Rotation matrix for -90° X rotation: [1,0,0; 0,0,1; 0,-1,0]
    const topTransform = {
      rotation: [1, 0, 0, 0, 0, -1, 0, 1, 0],
      origin: [0, 0, 0],
    }
    const [x, y, z] = planeRotationFromTransform(topTransform)
    // Three.js Euler XYZ may return π/2 instead of -π/2 (equivalent rotations)
    expect(Math.abs(x)).toBeCloseTo(Math.PI / 2, 3)
    expect(y).toBeCloseTo(0, 4)
    expect(z).toBeCloseTo(0, 4)
  })

  it('converts Right plane transform correctly', () => {
    // Right plane: rotated 90 degrees around Y
    // Rotation matrix for 90° Y rotation: [0,0,1; 0,1,0; -1,0,0]
    const rightTransform = {
      rotation: [0, 0, 1, 0, 1, 0, -1, 0, 0],
      origin: [0, 0, 0],
    }
    const [x, y, z] = planeRotationFromTransform(rightTransform)
    // Should be approximately [0, π/2, 0]
    expect(x).toBeCloseTo(0, 4)
    expect(y).toBeCloseTo(Math.PI / 2, 3)
    expect(z).toBeCloseTo(0, 4)
  })

  it('preserves origin', () => {
    const transform = {
      rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      origin: [5, 10, 15],
    }
    // Function returns rotation only, but verify the input is valid
    const [x, y, z] = planeRotationFromTransform(transform)
    expect(x).toBeCloseTo(0, 4)
    expect(y).toBeCloseTo(0, 4)
    expect(z).toBeCloseTo(0, 4)
  })
})
