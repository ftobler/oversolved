// The assembly's measurement system, computed off the solved anchor table.
//
// The part editor measures sketch entities and B-rep queries (computeMeasurements
// + measurementRegistry), both keyed to `sketchEditorStore` and `BodyResult`
// data an assembly does not carry: `toBodyResults` ships only vertices+faces, no
// `face_data`. What the assembly does have, per pickable entity, is the anchor
// the solve placed there: a plane's centroid+normal, an edge's point+direction,
// a vertex's point. So measurement here reads those poses, not the mesh.
//
// Pure: no three.js, no store, no ID buffer. It maps selected entity keys to
// anchor poses through the same lookup the mate pick uses, then measures.

import type { AnchorPose } from '@/kernel/partBundle'
import { lookupAnchor, type AnchorTable } from '@/utils/anchorGizmos'
import type { EntityMateRefs } from '@/utils/anchorCandidates'
import { cross, dot, normalize, sub } from '@/utils/gizmoMath'
import type { Vec3 } from '@/utils/transform3d'

// A parallel test on unit normals: |dot| within this of 1 counts as parallel.
const PARALLEL_EPS = 1e-4

// A measurable primitive derived from an anchor. `dir` is a plane normal, an
// edge direction, or a circle axis depending on `type`; it is absent for a
// point.
interface Primitive {
  type: 'point' | 'plane' | 'axis' | 'circle'
  point: Vec3
  dir: Vec3 | null
}

/** An anchor kind maps to one measurable primitive class. */
function toPrimitive(anchor: AnchorPose): Primitive | null {
  const point = [...anchor.point] as Vec3
  const dir = normalize([...anchor.axis] as Vec3)
  switch (anchor.kind) {
    case 'plane':
      return dir ? { type: 'plane', point, dir } : null
    case 'point':
    case 'sphere':  // a sphere anchor's point is its centre; measure it as a point
      return { type: 'point', point, dir: null }
    case 'line':
    case 'cylinder':
    case 'cone':
      return dir ? { type: 'axis', point, dir } : null
    case 'circle':
    case 'torus':
      return dir ? { type: 'circle', point, dir } : null
    default:
      return null
  }
}

/** Resolve one selected entity key to its primary anchor's primitive. */
function primitiveForEntity(
  entityKey: string,
  entityMateRefs: Readonly<EntityMateRefs>,
  anchors: Readonly<AnchorTable>,
): Primitive | null {
  const ref = entityMateRefs[entityKey]?.[0]
  if (!ref) return null
  const anchor = lookupAnchor(anchors, ref)
  return anchor ? toPrimitive(anchor) : null
}

function fmt(n: number): string {
  return n.toFixed(2)
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
}

/** Signed perpendicular distance of a point from a plane, absolute. */
function pointToPlane(point: Vec3, plane: Primitive): number {
  const n = plane.dir as Vec3
  return Math.abs(dot(sub(point, plane.point), n))
}

/** Perpendicular distance of a point from an infinite line. */
function pointToAxis(point: Vec3, axis: Primitive): number {
  const d = axis.dir as Vec3
  const w = sub(point, axis.point)
  return Math.hypot(...cross(w, d))  // |w x d| with |d| = 1
}

/** Acute angle in degrees between two unit directions. */
function angleDeg(a: Vec3, b: Vec3): number {
  const c = Math.min(1, Math.max(-1, Math.abs(dot(a, b))))
  return (Math.acos(c) * 180) / Math.PI
}

function isParallel(a: Vec3, b: Vec3): boolean {
  return Math.abs(Math.abs(dot(a, b)) - 1) < PARALLEL_EPS
}

/** Two planes: distance when parallel, angle otherwise. */
function measurePlanePlane(a: Primitive, b: Primitive): string {
  const na = a.dir as Vec3
  const nb = b.dir as Vec3
  if (isParallel(na, nb)) return `plane distance: ${fmt(pointToPlane(b.point, a))} mm`
  return `plane angle: ${fmt(angleDeg(na, nb))}°`
}

/** Two axes/edges: distance when parallel, angle otherwise. */
function measureAxisAxis(a: Primitive, b: Primitive): string {
  const da = a.dir as Vec3
  const db = b.dir as Vec3
  if (isParallel(da, db)) return `parallel edges, distance: ${fmt(pointToAxis(b.point, a))} mm`
  return `edge angle: ${fmt(angleDeg(da, db))}°`
}

/** A line/edge against a plane: distance when parallel to it, angle otherwise. */
function measureAxisPlane(axis: Primitive, plane: Primitive): string {
  const d = axis.dir as Vec3
  const n = plane.dir as Vec3
  // Parallel to the plane means the direction is perpendicular to the normal.
  if (Math.abs(dot(d, n)) < PARALLEL_EPS) return `plane distance: ${fmt(pointToPlane(axis.point, plane))} mm`
  return `line-plane angle: ${fmt(90 - angleDeg(d, n))}°`
}

/** The one measurement two primitives yield, or null when the pair has none. */
function measurePair(a: Primitive, b: Primitive): string | null {
  const kinds = [a.type, b.type]
  const has = (k: Primitive['type']) => kinds.includes(k)

  if (a.type === 'plane' && b.type === 'plane') return measurePlanePlane(a, b)

  if (has('plane') && has('point')) {
    const plane = a.type === 'plane' ? a : b
    const point = a.type === 'point' ? a : b
    return `plane distance: ${fmt(pointToPlane(point.point, plane))} mm`
  }

  if (has('plane') && has('axis')) {
    const plane = a.type === 'plane' ? a : b
    const axis = a.type === 'axis' ? a : b
    return measureAxisPlane(axis, plane)
  }

  if (a.type === 'point' && b.type === 'point') {
    const d = distance(a.point, b.point)
    return d <= 0.01 ? null : `dist: ${fmt(d)} mm`
  }

  if (has('point') && has('axis')) {
    const point = a.type === 'point' ? a : b
    const axis = a.type === 'axis' ? a : b
    return `point-edge distance: ${fmt(pointToAxis(point.point, axis))} mm`
  }

  // Circles measure by their centre point against anything, plus axis rules when
  // paired with a line. Treat a circle as its centre for point-like pairings and
  // as an axis for angle/parallel pairings.
  if (a.type === 'axis' && b.type === 'axis') return measureAxisAxis(a, b)

  if (has('circle')) {
    const circle = a.type === 'circle' ? a : b
    const other = a.type === 'circle' ? b : a
    if (other.type === 'circle') return `center dist: ${fmt(distance(a.point, b.point))} mm`
    if (other.type === 'point') return `center dist: ${fmt(distance(circle.point, other.point))} mm`
    if (other.type === 'axis') return measureAxisAxis(circle, other)
    if (other.type === 'plane') return measureAxisPlane(circle, other)
  }

  return null
}

/**
 * The measurement string for the current assembly selection, or an empty array
 * when the selection names nothing measurable. Mirrors computeMeasurements'
 * "0 or 1 element" contract so the footer display can stay identical.
 *
 * Only pairs are measured: an anchor pose carries no radius, length or area, so
 * a single entity has nothing to report. A selection larger than two measures
 * its first two resolvable primitives, which is enough for the distance/angle
 * flow and keeps the readout unambiguous.
 */
export function computeAssemblyMeasurements(
  selection: ReadonlySet<string>,
  entityMateRefs: Readonly<EntityMateRefs>,
  anchors: Readonly<AnchorTable>,
): string[] {
  const primitives: Primitive[] = []
  for (const key of selection) {
    const prim = primitiveForEntity(key, entityMateRefs, anchors)
    if (prim) primitives.push(prim)
    if (primitives.length === 2) break
  }
  if (primitives.length < 2) return []
  const result = measurePair(primitives[0], primitives[1])
  return result ? [result] : []
}
