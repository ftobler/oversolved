/**
 * The shared BRepGProp mass reads (volume, surface area). They live in this
 * leaf module because canonicalSurfaces.ts cannot import booleans.ts (booleans
 * imports canonicalSurfaces), and a second local copy would let the reads drift.
 */

import type { DisposeScope } from './disposeScope'
import type { OccModule, OccShape } from './occTypes'

/**
 * Volume of a (closed) shape (mirrors cadquery Solid.Volume / GProp mass).
 * VolumeProperties runs with OnlyClosed = true (the first flag), so a solid
 * whose shell is not closed integrates to ~0 -- that is the L5 trap: use a
 * solid count, not this, when the question is "do two shapes share material".
 */
export function volumeOf(oc: OccModule, scope: DisposeScope, shape: OccShape): number {
  const props = scope.track(new oc.GProp_GProps_1())
  oc.BRepGProp.VolumeProperties_1(shape, props, true, false, false)
  return props.Mass()
}

/**
 * Surface area of a shape: the sum over its faces (open shells included).
 * Skips shared faces and triangulation, so it is the exact B-rep integral the
 * per-face `faceArea` readers agree with.
 */
export function surfaceAreaOf(oc: OccModule, scope: DisposeScope, shape: OccShape): number {
  const props = scope.track(new oc.GProp_GProps_1())
  oc.BRepGProp.SurfaceProperties_1(shape, props, false, false)
  return props.Mass()
}
