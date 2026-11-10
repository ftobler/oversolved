// Warning for a boolean result that kept two near-coaxial cylinder faces.
//
// The fuse keeps two analytic cylinder faces when their radii or axes differ
// at all: ShapeUpgrade_UnifySameDomain only merges faces that share the same
// surface, and canonicalSurfaces.ts rebuilds fitted/opposed faces, not two
// analytic cylinders that merely sit within CLUSTER_TOL. The result is a real
// but microscopic shoulder. A fillet at the junction then has nowhere to roll
// and the kernel refuses with the bare `build_failed`; the practice trigger
// (a boss cylinder swallowing a tangent-arc wall) and the precision audit's
// stepped-shaft table both land there.
//
// The band: the lower bound is half the 1e-6 document grid step, so a
// one-step difference (the commonest near-miss) cannot fall under it through
// f64 noise. The upper bound is a small share of the radius; above it the step
// is a visible feature the user can see and intends, not a near-miss. Snapping
// the faces together is deliberately NOT done: it would change authored
// geometry, and topology must not hinge on a geometric coincidence.

import type { DisposeScope } from './disposeScope'
import type { OccModule, OccShape } from './occTypes'
import { exploreFaces } from './edgeModifier'
import { faceSurfaceFrame } from './primitives'

/** The largest radius/axis difference still read as a near-miss, as a share of
 *  the larger radius (the plan's 1e-4 x r). */
const NEAR_COAXIAL_REL = 1e-4
/** The smallest difference a fuse can keep: half the document grid step, so a
 *  f64 read of a one-step (1e-6) difference cannot fall under the floor. */
const NEAR_COAXIAL_MIN = 5e-7
/** Parallel-axis gate, the same as canonicalSurfaces' sameCylinder. */
const AXIS_PARALLEL_EPS = 1e-9

type Vec3 = [number, number, number]

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const norm = (a: Vec3): number => Math.sqrt(dot(a, a))

// Enough digits to show the difference the warning is about: at r 10 the
// nearest pair is 10.000001, which 6 significant digits would print as 10.
const shown = (n: number): number => Number(n.toPrecision(12))

interface Cylinder {
  radius: number
  origin: Vec3
  axis: Vec3
}

/** The transverse distance between two parallel axis lines, or null when the
 *  directions are not parallel enough to be one line's family. */
function axisGap(a: Cylinder, b: Cylinder): number | null {
  if (Math.abs(dot(a.axis, b.axis)) < 1 - AXIS_PARALLEL_EPS) return null
  const d = a.axis
  const w = sub(b.origin, a.origin)
  const along = dot(w, d)
  const perpendicular: Vec3 = [w[0] - along * d[0], w[1] - along * d[1], w[2] - along * d[2]]
  return norm(perpendicular)
}

/**
 * A warning when `shape` keeps two cylindrical faces on the same axis whose
 * radii or axes are near-coaxial, or null when every such pair is far enough
 * apart to be a real, visible step. Best-effort: an unreadable face is skipped.
 */
export function nearCoaxialCylinderWarning(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
): string | null {
  // Best-effort: a stubbed or failed read must never break a build. The
  // warning is worth having, not worth throwing for.
  if (!oc) return null
  try {
    const cylinders: Cylinder[] = []
    const cylinderType = oc.GeomAbs_SurfaceType.GeomAbs_Cylinder.value
    for (const face of exploreFaces(oc, scope, shape)) {
      // faceSurfaceFrame also gives a radius for cones, spheres and tori; this
      // warning is about cylinders only.
      const adaptor = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
      if (adaptor.GetType().value !== cylinderType) continue
      const frame = faceSurfaceFrame(oc, scope, face)
      if (frame === null || frame.radius === undefined) continue
      cylinders.push({ radius: frame.radius, origin: frame.origin as Vec3, axis: frame.axis as Vec3 })
    }
    for (let i = 0; i < cylinders.length; i++) {
      for (let j = i + 1; j < cylinders.length; j++) {
        const a = cylinders[i]
        const b = cylinders[j]
        const gap = axisGap(a, b)
        if (gap === null) continue
        const radiusDelta = Math.abs(a.radius - b.radius)
        const largest = Math.max(a.radius, b.radius)
        if (largest <= 0) continue
        const delta = Math.max(radiusDelta, gap)
        if (delta < NEAR_COAXIAL_MIN || delta > NEAR_COAXIAL_REL * largest) continue
        const axes = gap > NEAR_COAXIAL_MIN ? `, axes ${shown(gap)} apart` : ''
        return `near-coaxial cylinder faces r ${shown(a.radius)} and r ${shown(b.radius)}${axes} ` +
          'were not merged; a later fillet at their junction may fail'
      }
    }
    return null
  } catch {
    return null
  }
}
