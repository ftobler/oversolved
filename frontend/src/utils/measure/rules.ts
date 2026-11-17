// The one pair table: pick the single best measurement a pair of world-space
// primitives admits. Pure data and pure functions; no OCC, no stores, no
// viewport.
//
// Dispatch is an unordered (class, class) table, so pick order never changes the
// answer and every cell is visible in one place. A cell with no rule returns
// null; a cell the kernel must answer (a spline edge, a whole body) returns a
// `KernelAsk` marker, which the caller renders as nothing until the
// measure-kernel-pairs follow-up lands.
import { cross, dot, sub } from '@/utils/vec3'
import {
  distance,
  normalize,
  parallelLineDistance,
  pointToAxisDistance,
  segmentDistance,
  type CirclePrimitive,
  type ConePrimitive,
  type CylinderPrimitive,
  type EllipsePrimitive,
  type LinePrimitive,
  type OpaquePrimitive,
  type PlanePrimitive,
  type PointPrimitive,
  type Primitive,
  type SolidPrimitive,
  type SpherePrimitive,
  type TorusPrimitive,
  type Vec3,
} from './primitives'

/** The vocabulary every readout label comes from. The qualifier (`axis
 *  distance`, `center distance`) is kept only where the measured reference is
 *  not visible on screen. */
export type ReadoutKind = 'length' | 'distance' | 'angle' | 'diameter' | 'radius'

export interface Readout {
  kind: ReadoutKind
  // Lengths in the document unit, angles in degrees.
  value: number
  label: string
  /** A second readout for one pick pair or single: the sweep of an arc, the
   *  minor radius of an ellipse/torus, the distance of a skew edge pair. */
  extra?: Readout[]
}

/** A cell OCCT must answer. Nothing renders until measure-kernel-pairs ships
 *  the worker call; the marker exists so the cell is not silently re-derived
 *  from a wrong analytic approximation. */
export interface KernelAsk {
  kernel: 'length' | 'distance' | 'clearance'
}

export type MeasureResult = Readout | KernelAsk | null

export function isKernelAsk(result: MeasureResult): result is KernelAsk {
  return result != null && 'kernel' in result
}

// ─── Tolerances ───

/** Two unit directions within this angle count as parallel (the same
 *  threshold the old 3D edge rule used). */
export const PARALLEL_ANGLE_EPS_RAD = 1e-4
/** Two unit directions within this angle of a right angle count as
 *  perpendicular. */
export const PERPENDICULAR_ANGLE_EPS_RAD = 1e-4
// Two non-parallel lines closer than this are coplanar: the pair reports its
// angle alone, because the segment-to-segment minimum is the crossing point
// (zero) rather than a gap worth a second readout.
const COPLANAR_EPS = 1e-6
const TWO_PI = Math.PI * 2
// A full circle's sweep, with room for a solver that reports 2 pi minus a
// rounding step:
const FULL_CIRCLE_EPS = 1e-9

// ─── Direction relations ───

function acuteAngle(a: Vec3, b: Vec3): number {
  return Math.acos(Math.max(0, Math.min(1, Math.abs(dot(a, b)))))
}

function isParallel(a: Vec3, b: Vec3): boolean {
  return acuteAngle(a, b) < PARALLEL_ANGLE_EPS_RAD
}

function isPerpendicular(a: Vec3, b: Vec3): boolean {
  return Math.abs(acuteAngle(a, b) - Math.PI / 2) < PERPENDICULAR_ANGLE_EPS_RAD
}

function degrees(rad: number): number {
  return (rad * 180) / Math.PI
}

function angleReadout(a: Vec3, b: Vec3): Readout {
  return { kind: 'angle', value: degrees(acuteAngle(a, b)), label: 'angle' }
}

/** Angle a direction makes with a plane, from its angle to the plane normal. */
function directionPlaneAngle(dir: Vec3, normal: Vec3): Readout {
  return { kind: 'angle', value: 90 - degrees(acuteAngle(dir, normal)), label: 'angle' }
}

function distanceReadout(value: number, label = 'distance'): Readout {
  return { kind: 'distance', value, label }
}

function pointToPlane(p: Vec3, plane: PlanePrimitive): number {
  return Math.abs(dot(sub(p, plane.point), plane.normal))
}

// ─── Primitive classes ───

/**
 * How the pair table sees a primitive. A sphere is its centre and a circle is
 * its centre for point pairings, while an ellipse and a circle both carry an
 * axis for plane/axis pairings; a cone and a torus pair through their axis like
 * a cylinder.
 */
type MeasureClass = 'point' | 'line' | 'circle' | 'plane' | 'axis' | 'opaque' | 'solid'

type PointLike = PointPrimitive | SpherePrimitive
type CircleLike = CirclePrimitive | EllipsePrimitive
type AxisLike = CylinderPrimitive | ConePrimitive | TorusPrimitive

interface ClassPrimitive {
  point: PointLike
  line: LinePrimitive
  circle: CircleLike
  plane: PlanePrimitive
  axis: AxisLike
  opaque: OpaquePrimitive
  solid: SolidPrimitive
}

function classOf(p: Primitive): MeasureClass {
  switch (p.type) {
    case 'point':
    case 'sphere':
      return 'point'
    case 'line':
      return 'line'
    case 'circle':
    case 'ellipse':
      return 'circle'
    case 'plane':
      return 'plane'
    case 'cylinder':
    case 'cone':
    case 'torus':
      return 'axis'
    case 'opaque':
      return 'opaque'
    case 'solid':
      return 'solid'
  }
}

function centreOf(p: PointLike | CircleLike): Vec3 {
  return p.type === 'point' ? p.p : p.center
}

function axisPointOf(p: AxisLike): Vec3 {
  return p.type === 'cylinder' ? p.axisPoint : p.type === 'cone' ? p.axisPoint : p.center
}

function axisOf(p: AxisLike): Vec3 {
  return p.axis
}

function axisOfCircle(c: CircleLike): Vec3 {
  return c.axis
}

// ─── The pair table ───

interface PairCell {
  a: MeasureClass
  b: MeasureClass
  // The registry page's one-line description of the cell.
  readout: string
  measure: (a: Primitive, b: Primitive) => Readout | null
}

function cell<A extends MeasureClass, B extends MeasureClass>(
  a: A,
  b: B,
  readout: string,
  measure: (a: ClassPrimitive[A], b: ClassPrimitive[B]) => Readout | null,
): PairCell {
  return { a, b, readout, measure: measure as (a: Primitive, b: Primitive) => Readout | null }
}

const PAIR_TABLE: readonly PairCell[] = [
  cell('point', 'point', 'distance', (a, b) => distanceReadout(distance(centreOf(a), centreOf(b)))),

  cell('point', 'line', 'distance to the line', (p, l) =>
    // The infinite line, matching the sketch distance constraint and the
    // assembly rule (D6), not the nearest point of the segment.
    distanceReadout(pointToAxisDistance(centreOf(p), l.p0, l.dir))),

  cell('point', 'circle', 'distance to the centre', (p, c) =>
    distanceReadout(distance(centreOf(p), centreOf(c)), 'center distance')),

  cell('point', 'plane', 'distance to the plane', (p, pl) =>
    distanceReadout(pointToPlane(centreOf(p), pl))),

  cell('point', 'axis', 'distance to the axis', (p, ax) =>
    distanceReadout(pointToAxisDistance(centreOf(p), axisPointOf(ax), axisOf(ax)), 'axis distance')),

  cell('line', 'line', 'parallel: distance; else angle', (a, b) => {
    if (isParallel(a.dir, b.dir)) return distanceReadout(parallelLineDistance(a.p0, b.p0, a.dir))
    const angle = angleReadout(a.dir, b.dir)
    // Non-parallel, non-coplanar segments: the angle alone does not describe the
    // pair, so the closed-form segment minimum rides along as a second readout
    // (D4). Two coplanar lines cross, so the distance would only ever be 0.
    const normal = normalize(cross(a.dir, b.dir))
    if (!normal || !a.bounded || !b.bounded) return angle
    if (Math.abs(dot(sub(b.p0, a.p0), normal)) <= COPLANAR_EPS) return angle
    return { ...angle, extra: [distanceReadout(segmentDistance(a.p0, a.p1, b.p0, b.p1))] }
  }),

  cell('line', 'circle', 'distance from the centre to the line', (l, c) =>
    distanceReadout(pointToAxisDistance(centreOf(c), l.p0, l.dir), 'center distance')),

  cell('line', 'plane', 'parallel: distance; else angle', (l, pl) => {
    if (isPerpendicular(l.dir, pl.normal)) return distanceReadout(pointToPlane(l.p0, pl))
    return directionPlaneAngle(l.dir, pl.normal)
  }),

  cell('line', 'axis', 'parallel: distance; else angle', (l, ax) => {
    if (isParallel(l.dir, axisOf(ax))) {
      return distanceReadout(parallelLineDistance(l.p0, axisPointOf(ax), l.dir), 'axis distance')
    }
    return angleReadout(l.dir, axisOf(ax))
  }),

  cell('circle', 'circle', 'center distance', (a, b) =>
    distanceReadout(distance(centreOf(a), centreOf(b)), 'center distance')),

  cell('circle', 'plane', 'parallel: center-to-plane distance; else angle', (c, pl) => {
    if (isParallel(axisOfCircle(c), pl.normal)) return distanceReadout(pointToPlane(centreOf(c), pl))
    return angleReadout(axisOfCircle(c), pl.normal)
  }),

  cell('circle', 'axis', 'parallel axes: distance; else angle', (c, ax) => {
    if (isParallel(axisOfCircle(c), axisOf(ax))) {
      return distanceReadout(parallelLineDistance(centreOf(c), axisPointOf(ax), axisOfCircle(c)), 'axis distance')
    }
    return angleReadout(axisOfCircle(c), axisOf(ax))
  }),

  cell('plane', 'plane', 'parallel: distance; else angle', (a, b) => {
    if (isParallel(a.normal, b.normal)) return distanceReadout(pointToPlane(b.point, a))
    return angleReadout(a.normal, b.normal)
  }),

  cell('plane', 'axis', 'axis parallel to the plane: distance; else angle', (pl, ax) => {
    if (isPerpendicular(axisOf(ax), pl.normal)) {
      return distanceReadout(pointToPlane(axisPointOf(ax), pl), 'axis distance')
    }
    return directionPlaneAngle(axisOf(ax), pl.normal)
  }),

  cell('axis', 'axis', 'parallel axes: distance; else angle', (a, b) => {
    if (isParallel(axisOf(a), axisOf(b))) {
      return distanceReadout(parallelLineDistance(axisPointOf(a), axisPointOf(b), axisOf(a)), 'axis distance')
    }
    return angleReadout(axisOf(a), axisOf(b))
  }),
]

const PAIR_INDEX = new Map<string, PairCell>(
  PAIR_TABLE.map((c) => [c.a < c.b ? `${c.a}|${c.b}` : `${c.b}|${c.a}`, c]),
)

/**
 * The one measurement two primitives yield, or null when the pair has none.
 * Opaque and whole-body picks are kernel cells: they read nothing until the
 * kernel follow-up answers them, rather than falling back to a guess built on
 * the wrong face data.
 */
export function measurePair(a: Primitive, b: Primitive): MeasureResult {
  const classA = classOf(a)
  const classB = classOf(b)
  if (classA === 'opaque' || classB === 'opaque' || classA === 'solid' || classB === 'solid') {
    // A minimum distance between two classifiable-but-freeform shapes is the
    // kernel's clearance question; a freeform edge alone is its length.
    const both = (classA === 'opaque' || classA === 'solid') && (classB === 'opaque' || classB === 'solid')
    return { kernel: both ? 'clearance' : 'distance' }
  }
  const found = PAIR_INDEX.get(classA < classB ? `${classA}|${classB}` : `${classB}|${classA}`)
  if (!found) return null
  const first = found.a === classA ? a : b
  const second = found.a === classA ? b : a
  return found.measure(first, second)
}

/**
 * The one measurement a single pick states. A flat face, a vertex, a datum
 * plane and a whole body deliberately read nothing (D2); a curved face reads
 * its diameter, an arc its radius and sweep, a line its length.
 */
export function measureOne(p: Primitive): MeasureResult {
  switch (p.type) {
    case 'line':
      return { kind: 'length', value: distance(p.p0, p.p1), label: 'length' }
    case 'circle':
      if (p.radius == null || p.sweep == null) return null
      if (p.sweep >= TWO_PI - FULL_CIRCLE_EPS) return { kind: 'diameter', value: p.radius * 2, label: 'diameter' }
      return {
        kind: 'radius',
        value: p.radius,
        label: 'radius',
        extra: [{ kind: 'angle', value: degrees(p.sweep), label: 'angle' }],
      }
    case 'ellipse':
      return {
        kind: 'radius',
        value: p.a,
        label: 'major radius',
        extra: [{ kind: 'radius', value: p.b, label: 'minor radius' }],
      }
    case 'cylinder':
      return p.radius == null ? null : { kind: 'diameter', value: p.radius * 2, label: 'diameter' }
    case 'sphere':
      return p.radius == null ? null : { kind: 'diameter', value: p.radius * 2, label: 'diameter' }
    case 'cone':
      return p.semiAngle == null
        ? null
        : { kind: 'angle', value: degrees(p.semiAngle), label: 'angle' }
    case 'torus':
      if (p.majorRadius == null || p.minorRadius == null) return null
      return {
        kind: 'radius',
        value: p.majorRadius,
        label: 'major radius',
        extra: [{ kind: 'radius', value: p.minorRadius, label: 'minor radius' }],
      }
    case 'opaque':
      return { kernel: 'length' }
    case 'point':
    case 'plane':
    case 'solid':
      return null
  }
}

// ─── Registry page rows ───

const CLASS_LABEL: Record<MeasureClass, string> = {
  point: 'point',
  line: 'line',
  circle: 'circle',
  plane: 'plane',
  axis: 'cylinder',
  opaque: 'opaque',
  solid: 'body',
}

export interface SingleRuleRow {
  pick: string
  readout: string
}

/** The single-pick half of the readout table, shown on the Registry page. It
 *  names the same branches `measureOne` implements; keep the two together. */
export const SINGLE_RULES: readonly SingleRuleRow[] = [
  { pick: 'line (edge or sketch)', readout: 'length' },
  { pick: 'arc', readout: 'radius and sweep' },
  { pick: 'full circle', readout: 'diameter' },
  { pick: 'cylinder face', readout: 'diameter' },
  { pick: 'sphere face', readout: 'diameter' },
  { pick: 'ellipse', readout: 'major and minor radius' },
  { pick: 'cone face', readout: 'half angle, once surface_frame reports it' },
  { pick: 'torus face', readout: 'major and minor radius, once surface_frame reports it' },
  { pick: 'spline edge, partial ellipse edge', readout: 'kernel length (pending)' },
  { pick: 'flat face, vertex, datum plane, whole body', readout: 'nothing' },
]

export interface PairRuleRow {
  a: string
  b: string
  readout: string
}

/** The pair half, derived from the dispatch table so the page cannot drift from
 *  the rules. */
export const PAIR_RULES: readonly PairRuleRow[] = PAIR_TABLE.map((c) => ({
  a: CLASS_LABEL[c.a],
  b: CLASS_LABEL[c.b],
  readout: c.readout,
}))
