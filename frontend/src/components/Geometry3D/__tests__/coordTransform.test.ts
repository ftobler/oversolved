import { describe, it, expect } from 'vitest'
import { applyQuaternionInverse, worldToSketchLocalPure } from '@/components/Geometry3D/coordTransform'

// Identity quaternion [x, y, z, w] = [0, 0, 0, 1]
const IDENTITY: [number, number, number, number] = [0, 0, 0, 1]

// 90-degree rotation around Z: [x, y, z, w] = [0, 0, sin(45deg), cos(45deg)]
const ROT_Z_90: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2]

describe('applyQuaternionInverse', () => {
  it('identity quaternion leaves vector unchanged', () => {
    const result = applyQuaternionInverse([3, 4, 0], IDENTITY)
    expect(result[0]).toBeCloseTo(3)
    expect(result[1]).toBeCloseTo(4)
    expect(result[2]).toBeCloseTo(0)
  })

  it('90-degree Z rotation inverse maps x->-y, y->x', () => {
    // applyQuaternionInverse with ROT_Z_90 should be the inverse of rotating +90deg around Z
    // forward rotation: x->[0,1,0] (x maps to y), y->[-1,0,0] (y maps to -x)
    // inverse: x->[0,-1,0], y->[1,0,0]
    const rx = applyQuaternionInverse([1, 0, 0], ROT_Z_90)
    expect(rx[0]).toBeCloseTo(0)
    expect(rx[1]).toBeCloseTo(-1)
    expect(rx[2]).toBeCloseTo(0)

    const ry = applyQuaternionInverse([0, 1, 0], ROT_Z_90)
    expect(ry[0]).toBeCloseTo(1)
    expect(ry[1]).toBeCloseTo(0)
    expect(ry[2]).toBeCloseTo(0)
  })

  it('zero vector stays zero regardless of quaternion', () => {
    const result = applyQuaternionInverse([0, 0, 0], ROT_Z_90)
    expect(result[0]).toBeCloseTo(0)
    expect(result[1]).toBeCloseTo(0)
    expect(result[2]).toBeCloseTo(0)
  })

  it('mixed-axis (X then Z) rotation inverts against a hand-computed result', () => {
    // q = qz(90) * qx(90) = [x, y, z, w] = [0.5, 0.5, 0.5, 0.5].
    // Forward maps x->y, y->z, z->x, so the inverse maps x->z, y->x, z->y.
    const mixed: [number, number, number, number] = [0.5, 0.5, 0.5, 0.5]
    const ix = applyQuaternionInverse([1, 0, 0], mixed)
    expect(ix[0]).toBeCloseTo(0)
    expect(ix[1]).toBeCloseTo(0)
    expect(ix[2]).toBeCloseTo(1)

    const iy = applyQuaternionInverse([0, 1, 0], mixed)
    expect(iy[0]).toBeCloseTo(1)
    expect(iy[1]).toBeCloseTo(0)
    expect(iy[2]).toBeCloseTo(0)

    const iz = applyQuaternionInverse([0, 0, 1], mixed)
    expect(iz[0]).toBeCloseTo(0)
    expect(iz[1]).toBeCloseTo(1)
    expect(iz[2]).toBeCloseTo(0)
  })
})

describe('worldToSketchLocalPure', () => {
  it('identity transform with no parent offset maps world point to same coordinates', () => {
    const result = worldToSketchLocalPure([3, 4, 0], [0, 0, 0], IDENTITY)
    expect(result[0]).toBeCloseTo(3)
    expect(result[1]).toBeCloseTo(4)
  })

  it('translated parent: removes parent offset from world point', () => {
    // Parent at [10, 0, 0] -- local coords are world minus parent
    const result = worldToSketchLocalPure([13, 4, 0], [10, 0, 0], IDENTITY)
    expect(result[0]).toBeCloseTo(3)
    expect(result[1]).toBeCloseTo(4)
  })

  it('90-degree Z rotation: x in world maps to local -y', () => {
    // Parent rotated 90deg around Z, at origin
    // World [1, 0, 0] should be local [0, -1, 0] (inverse of 90deg Z rotation)
    const result = worldToSketchLocalPure([1, 0, 0], [0, 0, 0], ROT_Z_90)
    expect(result[0]).toBeCloseTo(0)
    expect(result[1]).toBeCloseTo(-1)
  })

  it('combined translation and rotation', () => {
    // Parent at [5, 5, 0] rotated 90deg around Z
    // World point [6, 5, 0]: translated -> [1, 0, 0], then inverse-rot -> [0, -1, 0]
    const result = worldToSketchLocalPure([6, 5, 0], [5, 5, 0], ROT_Z_90)
    expect(result[0]).toBeCloseTo(0)
    expect(result[1]).toBeCloseTo(-1)
  })

  it('returns z component reflecting distance from sketch plane', () => {
    // Point at world z=0.5 with identity parent at origin -> local z=0.5
    const result = worldToSketchLocalPure([0, 0, 0.5], [0, 0, 0], IDENTITY)
    expect(result[2]).toBeCloseTo(0.5)
  })
})
