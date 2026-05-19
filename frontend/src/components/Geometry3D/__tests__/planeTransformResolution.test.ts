import { describe, it, expect } from 'vitest'
import { builtinPlaneTransform } from '@/components/Geometry3D/bodySnapProjection'
import { planeRotationFromTransform, planeRotation } from '@/components/Geometry3D/utils'
import type { PlaneTransform } from '@/types/cad'

/**
 * Pure reimplementation of the resolvedPlaneTransform logic from
 * Geometry3D/index.tsx for testability.
 */
function resolvePlaneTransform(
  planeTransform: PlaneTransform | undefined,
  plane: string | undefined,
): PlaneTransform | undefined {
  if (planeTransform) return planeTransform
  if (plane) return builtinPlaneTransform(plane) ?? undefined
  return undefined
}

describe('resolvedPlaneTransform', () => {
  it('uses solver result when planeTransform is provided', () => {
    const solverTransform: PlaneTransform = {
      rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      origin: [10, 20, 30],
    }
    const result = resolvePlaneTransform(solverTransform, '@builtin_plane_front')
    expect(result).toBe(solverTransform)
  })

  it('falls back to builtin plane transform for top plane', () => {
    const expected = builtinPlaneTransform('@builtin_plane_top')
    const result = resolvePlaneTransform(undefined, '@builtin_plane_top')
    expect(result).toEqual(expected)
  })

  it('falls back to builtin plane transform for right plane', () => {
    const expected = builtinPlaneTransform('@builtin_plane_right')
    const result = resolvePlaneTransform(undefined, '@builtin_plane_right')
    expect(result).toEqual(expected)
  })

  it('returns undefined when planeTransform absent and plane unresolvable', () => {
    const result = resolvePlaneTransform(undefined, undefined)
    expect(result).toBeUndefined()
  })

  it('returns undefined when plane is unknown', () => {
    const result = resolvePlaneTransform(undefined, 'some_random_plane')
    expect(result).toBeUndefined()
  })
})

describe('builtin plane Euler consistency', () => {
  const planes = [
    '@builtin_plane_front',
    '@builtin_plane_top',
    '@builtin_plane_right',
  ]

  for (const plane of planes) {
    it(`planeRotationFromTransform(builtinPlaneTransform(${plane})) equals planeRotation(${plane})`, () => {
      const pt = builtinPlaneTransform(plane)
      expect(pt).not.toBeNull()
      const fromTransform = planeRotationFromTransform(pt!)
      const fromQuery = planeRotation(plane)
      expect(fromTransform[0]).toBeCloseTo(fromQuery[0], 4)
      expect(fromTransform[1]).toBeCloseTo(fromQuery[1], 4)
      expect(fromTransform[2]).toBeCloseTo(fromQuery[2], 4)
    })
  }
})
