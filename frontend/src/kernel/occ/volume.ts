/**
 * The shared BRepGProp mass reads (volume, surface area). They live in this
 * leaf module because canonicalSurfaces.ts cannot import booleans.ts (booleans
 * imports canonicalSurfaces), and a second local copy would let the reads drift.
 *
 * Three accuracy rules, each named for what it is good at (the probes live in
 * occ/__tests__/gpropEpsReal.test.ts):
 *
 * - The decision volume read (`volumeOf`) is the adaptive eps overload with
 *   GPROP_EPS: it has an accuracy target, so a BSPLINE-trimmed face no longer
 *   lands ~2e-6 of the body off and flips a 1e-6 budget. It is fast enough for
 *   the many reads a boolean pays.
 * - The reporting volume read (`volumeForMeasure`) is Gauss-Kronrod. The plain
 *   eps rule over-integrates a BSPLINE *surface* (6.7% on the fitted-spline
 *   probe), where GK lands on the analytic value. GK is not used for decisions:
 *   on one boolean-path shape its first read took minutes, which is a hang, not
 *   a cost a guard may pay.
 * - The surface read stays on the default rule: on the same probe the eps
 *   surface rule is the inaccurate one (6.7% high) and the default rule is
 *   within 3e-6. No volume verdict reads area.
 *
 * The same-geometry guards (the UnifySameDomain clean, the canonical heal, the
 * edge heal) read `volumeOfDefault`: they compare a shape with itself before
 * and after a topology-only step, so the default rule's correlated error
 * cancels in the difference, while an adaptive read's independent refinements
 * can flip the verdict (fuzz seed 235).
 */

import type { DisposeScope } from './disposeScope'
import type { OccModule, OccShape, OccXYZ } from './occTypes'
import type { Vec3 } from './primitives'
import { GPROP_EPS } from '../solverConstants'

/** The fast adaptive volume read decisions use. */
function volumePropsOf(oc: OccModule, scope: DisposeScope, shape: OccShape) {
  const props = scope.track(new oc.GProp_GProps_1())
  oc.BRepGProp.VolumeProperties_2(shape, props, GPROP_EPS, true, false)
  return props
}

/** The accurate volume read reports use (see the module note for the cost). */
function accurateVolumePropsOf(oc: OccModule, scope: DisposeScope, shape: OccShape) {
  const props = scope.track(new oc.GProp_GProps_1())
  oc.BRepGProp.VolumePropertiesGK_1(shape, props, GPROP_EPS, true, false, false, false, false)
  return props
}

/**
 * The default fixed read. It is the accurate one for the centre (the probe
 * shows GK's CentreOfMass is off by ~2e-4 on a BSPLINE surface even with
 * CGFlag set) and it is what the same-geometry guards compare with.
 */
function defaultVolumePropsOf(oc: OccModule, scope: DisposeScope, shape: OccShape) {
  const props = scope.track(new oc.GProp_GProps_1())
  oc.BRepGProp.VolumeProperties_1(shape, props, true, false, false)
  return props
}

/** The one GProp surface read; shared by the whole-shape area and the per-face
 *  centroid/area readers in primitives.ts. Default rule, see the module note. */
function surfacePropsOf(oc: OccModule, scope: DisposeScope, shape: OccShape) {
  const props = scope.track(new oc.GProp_GProps_1())
  oc.BRepGProp.SurfaceProperties_1(shape, props, false, false)
  return props
}

/**
 * Volume and volume-weighted centroid for the measure record. Two GProp passes
 * on purpose: the accurate volume rule (GK) and the accurate centre rule (the
 * default one) are different rules on a BSPLINE surface, so one pass cannot
 * give both. Both run with OnlyClosed = true (the first flag), so a solid
 * whose shell is not closed integrates to zero and its centre is the origin.
 */
export function volumeAndCentroidOf(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
): { volume: number; centroid: Vec3 } {
  const volume = accurateVolumePropsOf(oc, scope, shape).Mass()
  return { volume, centroid: centroidOfProps(defaultVolumePropsOf(oc, scope, shape)) }
}

/**
 * Volume-weighted centroid alone. The split-body ordering key wants only the
 * centre, so it must not pay the accurate volume pass too.
 */
export function volumeCentroidOf(oc: OccModule, scope: DisposeScope, shape: OccShape): Vec3 {
  return centroidOfProps(defaultVolumePropsOf(oc, scope, shape))
}

/**
 * Volume under the default fixed rule. Only for a guard comparing the SAME
 * geometry before and after a topology-only step: the correlated read error
 * cancels in the difference, while the adaptive rule can flip the verdict and
 * rewrite the face UUIDs under a perturbed rebuild (fuzz seed 235).
 */
export function volumeOfDefault(oc: OccModule, scope: DisposeScope, shape: OccShape): number {
  return defaultVolumePropsOf(oc, scope, shape).Mass()
}

function centroidOfProps(props: { CentreOfMass(): OccXYZ }): Vec3 {
  const c = props.CentreOfMass()
  const centroid: Vec3 = [c.X(), c.Y(), c.Z()]
  c.delete()
  return centroid
}

/**
 * Volume of a (closed) shape for a decision (mirrors cadquery Solid.Volume /
 * GProp mass). The read runs with OnlyClosed = true, so a solid whose shell is
 * not closed integrates to ~0 -- that is the L5 trap: use a solid count, not
 * this, when the question is "do two shapes share material".
 */
export function volumeOf(oc: OccModule, scope: DisposeScope, shape: OccShape): number {
  return volumePropsOf(oc, scope, shape).Mass()
}

/**
 * Volume of a (closed) shape for a reported value. Same contract as `volumeOf`,
 * but the accurate rule: a consumer that reports a number must not print the
 * eps rule's BSPLINE-surface error.
 */
export function volumeForMeasure(oc: OccModule, scope: DisposeScope, shape: OccShape): number {
  return accurateVolumePropsOf(oc, scope, shape).Mass()
}

/**
 * Surface area of a shape: the sum over its faces (open shells included).
 * Shared faces included, no triangulation, so it is the exact B-rep integral
 * the per-face `faceArea` reader agrees with. A face is a shape here too, which
 * is why the per-face reader routes through this one.
 */
export function surfaceAreaOf(oc: OccModule, scope: DisposeScope, shape: OccShape): number {
  return surfacePropsOf(oc, scope, shape).Mass()
}

/** Area-weighted centroid of a surface (or of one face). */
export function surfaceCentroidOf(oc: OccModule, scope: DisposeScope, shape: OccShape): Vec3 {
  return centroidOfProps(surfacePropsOf(oc, scope, shape))
}
