// The analytic edge and face classification both pick adapters share.
//
// The part adapter reads `EdgeData` / `FaceData` from a solve result; the
// assembly adapter reads the bundle's `EdgeCurve` / `BundleFaceFact`. Those are
// different records for the same OCC facts, so each adapter maps its own record
// onto the minimal shapes below and the classification (which primitive, which
// sweep, whether a flat face is really a disc) lives here once. A rule that
// drifted between the two would make the assembly read a different number for
// the same geometry, which is the whole point of the parity tests.
import { dot } from '@/utils/vec3'
import { OCC_CONFUSION } from '@/kernel/solverConstants'
import {
  normalize,
  pointToAxisDistance,
  type Primitive,
  type Vec3,
} from '../primitives'

export const TWO_PI = Math.PI * 2

// A planar face counts as a disc or a ring when its tessellated area is within
// this fraction of the analytic value. The area on `face_data` is summed from
// triangles, so it sits slightly inside a curved boundary; Möbius accepts the
// same 2 percent for the same reason.
const CIRCULAR_FACE_AREA_TOLERANCE = 0.02

/**
 * The kernel's linear contract scaled by the radius: two arcs of one circle
 * may differ by this much in centre or radius and still be the same circle.
 * Scaling with the radius keeps the check relative on a large circle, where a
 * fixed 1e-7 would be tighter than the geometry the kernel actually hands over.
 */
export function circleTolerance(radius: number): number {
  return Math.max(OCC_CONFUSION, OCC_CONFUSION * Math.abs(radius))
}

export function isFullSweep(sweep: number, radius: number): boolean {
  return sweep >= TWO_PI - circleTolerance(radius) / Math.max(radius, 1e-12)
}

/** The analytic circle one edge states, for same-circle merging and disc boundaries. */
export interface BoundaryCircle {
  center: Vec3
  axis: Vec3
  radius: number
  sweep: number
}

/**
 * An edge record reduced to the fields the primitive needs. `kind` keeps the
 * part editor's four-way split (a full ellipse and a partial one read
 * differently); the assembly bundle's `b-spline` maps onto `spline`.
 */
export interface AnalyticEdge {
  kind: 'line' | 'circle' | 'ellipse' | 'spline'
  start?: Vec3
  end?: Vec3
  center?: Vec3
  axis?: Vec3
  radius?: number
  a?: number
  b?: number
  // An ellipse edge covering a full turn, so its semi-axes describe the curve.
  fullTurn?: boolean
}

/**
 * The world primitive an edge states. `sweep` is only read for a circle and is
 * the MERGED sweep the caller worked out (two half arcs on one face are one
 * circle, not two semicircles).
 */
export function analyticEdgePrimitive(
  edge: AnalyticEdge,
  sweep: number,
  ref: string,
): Primitive | null {
  switch (edge.kind) {
    case 'line': {
      const p0 = edge.start
      const p1 = edge.end
      if (!p0 || !p1) return null
      const dir = normalize([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]])
      return dir ? { type: 'line', p0: [...p0] as Vec3, p1: [...p1] as Vec3, dir, bounded: true } : null
    }
    case 'circle': {
      const axis = edge.axis ? normalize(edge.axis) : null
      if (!axis || edge.center == null || edge.radius == null) return null
      return {
        type: 'circle',
        center: [...edge.center] as Vec3,
        axis,
        radius: edge.radius,
        sweep: isFullSweep(sweep, edge.radius) ? TWO_PI : sweep,
      }
    }
    case 'ellipse': {
      const axis = edge.axis ? normalize(edge.axis) : null
      if (!axis || edge.center == null || edge.a == null || edge.b == null) return null
      // A partial elliptical edge (a cylinder cut, say) is an arc of that
      // ellipse and its length is the kernel's question, not a pair of
      // parent-ellipse radii.
      if (!edge.fullTurn) return { type: 'opaque', what: 'partial ellipse edge', ref }
      return { type: 'ellipse', center: [...edge.center] as Vec3, axis, a: edge.a, b: edge.b }
    }
    case 'spline':
      return { type: 'opaque', what: 'spline edge', ref }
  }
}

/** The analytic circle a circle-shaped edge states, or null for any other kind. */
export function boundaryCircleOf(edge: AnalyticEdge, sweep: number): BoundaryCircle | null {
  if (edge.kind !== 'circle') return null
  const axis = edge.axis ? normalize(edge.axis) : null
  if (!axis || edge.center == null || edge.radius == null) return null
  return { center: [...edge.center] as Vec3, axis, radius: edge.radius, sweep }
}

export function sameCircle(a: BoundaryCircle, b: BoundaryCircle): boolean {
  const tolerance = circleTolerance(a.radius)
  if (Math.abs(a.radius - b.radius) > tolerance) return false
  if (Math.hypot(
    a.center[0] - b.center[0],
    a.center[1] - b.center[1],
    a.center[2] - b.center[2],
  ) > tolerance) return false
  // Directions are unit, so the angle is the chord between them; scaling the
  // linear tolerance by the radius turns it into the matching angular bound.
  const angleTolerance = tolerance / Math.max(a.radius, 1e-12)
  return Math.abs(dot(a.axis, b.axis)) >= Math.cos(angleTolerance)
}

/**
 * A planar face's boundary reduced to circles. `undefined` means the boundary
 * held a line, spline or ellipse (so the face is not round); `[]` means the
 * face has no boundary at all. A disc is one full circle, a ring two or more
 * concentric full circles, and the area the face reports has to agree with
 * them: a slot or a pocket floor can be bounded by a circle without being a
 * disc, and the area is what tells the two apart.
 */
function circularBoundary(
  rings: readonly BoundaryCircle[] | undefined,
  normal: Vec3,
): BoundaryCircle[] | null {
  if (rings === undefined) return null
  for (const ring of rings) {
    if (!isFullSweep(ring.sweep, ring.radius)) return null
  }
  // Two half arcs both merge to the same full circle; keep it once.
  const unique: BoundaryCircle[] = []
  for (const ring of rings) {
    if (!unique.some((other) => sameCircle(other, ring))) unique.push(ring)
  }
  if (!unique.every((ring) => Math.abs(dot(ring.axis, normal)) >= Math.cos(OCC_CONFUSION))) {
    return null
  }
  const outer = unique.reduce((widest, ring) => (ring.radius > widest.radius ? ring : widest))
  for (const ring of unique) {
    if (pointToAxisDistance(ring.center, outer.center, normal) > circleTolerance(ring.radius)) {
      return null
    }
  }
  return unique
}

/**
 * A flat face that is really a round element: a disc (one boundary circle) or
 * a ring. It reads and pairs as a circle rather than as a flat face. An absent
 * area stays a plane, because the classification needs the face's own measure.
 */
export function circularFacePrimitive(
  rings: readonly BoundaryCircle[] | undefined,
  area: number | undefined,
  normal: Vec3,
): Primitive | null {
  if (area == null || !(area > 0)) return null
  const unique = circularBoundary(rings, normal)
  if (!unique || unique.length === 0) return null
  const outer = unique.reduce((widest, ring) => (ring.radius > widest.radius ? ring : widest))
  const innerRadii = unique
    .filter((ring) => ring !== outer)
    .reduce((sum, ring) => sum + ring.radius * ring.radius, 0)
  const expected = Math.PI * (outer.radius * outer.radius - innerRadii)
  if (!(expected > 0)) return null
  if (Math.abs(area - expected) > CIRCULAR_FACE_AREA_TOLERANCE * expected) return null
  return { type: 'circle', center: outer.center, axis: normal, radius: outer.radius, sweep: TWO_PI }
}

/** A face's analytic surface record, reduced from `FaceData` or a bundle fact. */
export interface AnalyticSurface {
  surfaceType?: string | null
  centroid: Vec3
  normal?: Vec3 | null
  frame?: {
    origin: Vec3
    axis: Vec3
    radius?: number
    semiAngle?: number
    minorRadius?: number
  } | null
}

/**
 * The primitive a face states, from `surface_type` and its analytic frame ONLY.
 * `face_data.normal` is the radial direction at a curved face's centroid, never
 * its axis, so reading it as a plane normal turns a hole into a plane at a
 * plausible-looking distance. `circular` is the round-flat-face classification
 * the caller built from the boundary, and `cylinderLength` the face's own axial
 * extent, when it could be measured.
 */
export function surfacePrimitive(
  surface: AnalyticSurface,
  circular: Primitive | null,
  cylinderLength: number | null,
  ref: string,
): Primitive | null {
  const opaque = (what: string): Primitive => ({ type: 'opaque', what, ref })
  switch (surface.surfaceType) {
    case 'flatface':
    case undefined:
    case null: {
      if (circular) return circular
      // A body solved before `surface_type` existed still has a meaningful
      // plane normal, so it keeps the flat-face reading.
      const normal = surface.normal ? normalize(surface.normal) : null
      if (!normal) return null
      return { type: 'plane', point: [...surface.centroid] as Vec3, normal, bounded: true }
    }
    case 'cylinderface': {
      const frame = surface.frame
      const axis = frame ? normalize(frame.axis) : null
      if (!frame || !axis || frame.radius == null) return opaque('cylinder face without an analytic frame')
      return {
        type: 'cylinder',
        axisPoint: [...frame.origin] as Vec3,
        axis,
        radius: frame.radius,
        ...(cylinderLength !== null && { length: cylinderLength }),
      }
    }
    case 'coneface': {
      const frame = surface.frame
      const axis = frame ? normalize(frame.axis) : null
      if (!frame || !axis) return opaque('cone face without an analytic frame')
      return {
        type: 'cone',
        axisPoint: [...frame.origin] as Vec3,
        axis,
        semiAngle: frame.semiAngle,
      }
    }
    case 'sphereface': {
      const frame = surface.frame
      if (!frame || frame.radius == null) return opaque('sphere face without an analytic frame')
      return { type: 'sphere', center: [...frame.origin] as Vec3, radius: frame.radius }
    }
    case 'torusface': {
      const frame = surface.frame
      const axis = frame ? normalize(frame.axis) : null
      if (!frame || !axis) return opaque('torus face without an analytic frame')
      return {
        type: 'torus',
        center: [...frame.origin] as Vec3,
        axis,
        majorRadius: frame.radius,
        minorRadius: frame.minorRadius,
      }
    }
    default:
      return opaque(`${surface.surfaceType ?? 'freeform'} face`)
  }
}
