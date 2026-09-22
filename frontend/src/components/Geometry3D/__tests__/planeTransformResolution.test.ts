import { describe, it, expect } from 'vitest'
import { builtinPlaneTransform, resolvePlaneTransform } from '@/components/Geometry3D/bodySnapProjection'
import { planeRotationFromTransform, planeRotation } from '@/components/Geometry3D/utils'
import type { PlaneTransform } from '@/types/cad'

// Exercises the real resolver Geometry3D/index.tsx calls, so its branches cannot
// drift behind a local copy.
describe('resolvePlaneTransform', () => {
  it('prefers the solver transform when one is supplied', () => {
    const solverTransform: PlaneTransform = {
      rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      origin: [10, 20, 30],
    }
    expect(resolvePlaneTransform(solverTransform, '@builtin_plane_front')).toBe(solverTransform)
  })

  it('falls back to the builtin transform for a named plane', () => {
    expect(resolvePlaneTransform(undefined, '@builtin_plane_top'))
      .toEqual(builtinPlaneTransform('@builtin_plane_top'))
    expect(resolvePlaneTransform(undefined, '@builtin_plane_right'))
      .toEqual(builtinPlaneTransform('@builtin_plane_right'))
  })

  it('is undefined when neither a transform nor a resolvable plane is given', () => {
    expect(resolvePlaneTransform(undefined, undefined)).toBeUndefined()
    expect(resolvePlaneTransform(undefined, 'some_random_plane')).toBeUndefined()
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
