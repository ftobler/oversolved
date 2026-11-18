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
export type ReadoutKind = 'length' | 'distance' | 'angle' | 'diameter' | 'radius' | 'area' | 'volume'

export interface Readout {
  kind: ReadoutKind
  // Lengths in the document unit, angles in degrees.
  value: number
  label: string
  /** A second readout for one pick pair or single: the sweep of an arc, the
   *  minor radius of an ellipse/torus, the distance of a skew edge pair, a
   *  delta leg, the supplement of an angle. */
  extra?: Readout[]
  /** A text-free qualifier on the number itself: the foot of a point-to-line
   *  distance lies on the edge's extension, not on the edge. The formatter
   *  renders it, so labels stay from one vocabulary. */
  note?: 'on extension'
}

/** A cell OCCT must answer: a spline edge's length or a face's area, the
 *  clearance between two bodies, the minimum distance one freeform pick leaves
 *  an analytic one, a body's volume. */
export interface KernelAsk {
  kernel: KernelOp
}

export type KernelOp = 'length' | 'distance' | 'clearance' | 'area' | 'volume'

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
// Two parallel lines or axes closer than this are the same line: collinear
// edges, coaxial rims.
const AXIS_EPS = 1e-6
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

/** An angle plus its supplement: the two wedges a pair of directions admits,
 *  stated together so the user need not subtract. */
function angleWithSupplement(value: number): Readout {
  return {
    kind: 'angle',
    value,
    label: 'angle',
    extra: [{ kind: 'angle', value: 180 - value, label: 'supplement' }],
  }
}

function angleReadout(a: Vec3, b: Vec3): Readout {
  return angleWithSupplement(degrees(acuteAngle(a, b)))
}

/** Angle a direction makes with a plane, from its angle to the plane normal. */
function directionPlaneAngle(dir: Vec3, normal: Vec3): Readout {
  return angleWithSupplement(90 - degrees(acuteAngle(dir, normal)))
}

function distanceReadout(value: number, label = 'distance'): Readout {
  return { kind: 'distance', value, label }
}

/**
 * The three world-axis legs between two points. The sign is dropped on purpose:
 * the pair table is unordered, and a signed delta would flip the whole readout
 * when the user picks the same two elements the other way round. The legs are
 * in the document frame and unit, so they square back to the distance.
 */
function deltaExtras(a: Vec3, b: Vec3): Readout[] {
  const delta = sub(b, a)
  return [
    distanceReadout(Math.abs(delta[0]), 'dx'),
    distanceReadout(Math.abs(delta[1]), 'dy'),
    distanceReadout(Math.abs(delta[2]), 'dz'),
  ]
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

/** The radius a pair rule can use, when the primitive states one. An assembly
 *  circle anchor carries a centre and an axis but no extent, and an ellipse's
 *  two semi-axes are not one radius. */
function radiusOfCircle(c: CircleLike): number | null {
  return c.type === 'circle' && c.radius != null ? c.radius : null
}

/** A cylinder face states a radius; a cone's frame radius is a reference
 *  height's radius and a torus's is its major radius, so neither names the
 *  outer surface a gap or span would be measured from. */
function axisRadiusOf(p: AxisLike): number | null {
  return p.type === 'cylinder' && p.radius != null ? p.radius : null
}

function midpoint(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
}

/** Distance from a point to the infinite line (the sketch distance constraint
 *  and D6, not the nearest point of the segment), with the foot's position on a
 *  bounded edge reported as a qualifier. */
function pointLineReadout(p: PointLike, l: LinePrimitive): Readout {
  const point = centreOf(p)
  const readout = distanceReadout(pointToAxisDistance(point, l.p0, l.dir))
  if (!l.bounded) return readout
  const length = distance(l.p0, l.p1)
  const foot = dot(sub(point, l.p0), l.dir)
  const slack = 1e-9 * Math.max(1, length)
  if (foot >= -slack && foot <= length + slack) return readout
  return { ...readout, note: 'on extension' }
}

// ─── The pair table ───

interface PairCell {
  a: MeasureClass
  b: MeasureClass
  // The registry page's one-line description of the cell.
  readout: string
  measure: (a: Primitive, b: Primitive) => MeasureResult
}

function cell<A extends MeasureClass, B extends MeasureClass>(
  a: A,
  b: B,
  readout: string,
  measure: (a: ClassPrimitive[A], b: ClassPrimitive[B]) => MeasureResult,
): PairCell {
  return { a, b, readout, measure: measure as (a: Primitive, b: Primitive) => MeasureResult }
}

const PAIR_TABLE: readonly PairCell[] = [
  cell('point', 'point', 'distance, with dx/dy/dz', (a, b) => {
    const pa = centreOf(a)
    const pb = centreOf(b)
    return { ...distanceReadout(distance(pa, pb)), extra: deltaExtras(pa, pb) }
  }),

  cell('point', 'line', 'distance to the line, from its extension too', (p, l) =>
    pointLineReadout(p, l)),

  cell('point', 'circle', 'distance to the centre, with dx/dy/dz', (p, c) => {
    const pa = centreOf(p)
    const pc = centreOf(c)
    return { ...distanceReadout(distance(pa, pc), 'center distance'), extra: deltaExtras(pa, pc) }
  }),

  cell('point', 'plane', 'distance to the plane', (p, pl) =>
    distanceReadout(pointToPlane(centreOf(p), pl))),

  cell('point', 'axis', 'distance to the axis', (p, ax) =>
    distanceReadout(pointToAxisDistance(centreOf(p), axisPointOf(ax), axisOf(ax)), 'axis distance')),

  cell('line', 'line', 'parallel: distance and alignment offset; collinear: kernel gap; else angle', (a, b) => {
    if (isParallel(a.dir, b.dir)) {
      const offset = parallelLineDistance(a.p0, b.p0, a.dir)
      // Two collinear bounded edges do not touch across their gap; the infinite
      // line's zero is not the useful number, so OCCT states the edge gap.
      if (offset <= AXIS_EPS && a.bounded && b.bounded) return { kernel: 'distance' }
      const readout = distanceReadout(offset)
      if (!a.bounded || !b.bounded) return readout
      const slide = Math.abs(dot(sub(midpoint(b.p0, b.p1), midpoint(a.p0, a.p1)), a.dir))
      return { ...readout, extra: [distanceReadout(slide, 'alignment offset')] }
    }
    const angle = angleReadout(a.dir, b.dir)
    // Non-parallel, non-coplanar segments: the angle alone does not describe the
    // pair, so the closed-form segment minimum rides along as a second readout
    // (D4). Two coplanar lines cross, so the distance would only ever be 0.
    const normal = normalize(cross(a.dir, b.dir))
    if (!normal || !a.bounded || !b.bounded) return angle
    if (Math.abs(dot(sub(b.p0, a.p0), normal)) <= COPLANAR_EPS) return angle
    return { ...angle, extra: [...(angle.extra ?? []), distanceReadout(segmentDistance(a.p0, a.p1, b.p0, b.p1))] }
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

  cell('circle', 'circle', 'parallel axes: pitch; coaxial: axial distance; else center distance or angle', (a, b) => {
    const ca = centreOf(a)
    const cb = centreOf(b)
    const axisA = axisOfCircle(a)
    const axisB = axisOfCircle(b)
    if (!isParallel(axisA, axisB)) return angleReadout(axisA, axisB)

    // Square to the axes: the pitch a bolt pattern is laid out on.
    const pitch = parallelLineDistance(ca, cb, axisA)
    const centreDistance = distance(ca, cb)
    const axial = Math.abs(dot(sub(cb, ca), axisA))
    const radiusA = radiusOfCircle(a)
    const radiusB = radiusOfCircle(b)

    if (pitch <= AXIS_EPS) {
      // Coaxial rims: the step between them is the axial distance, and two
      // different diameters add the radial gap between their circles.
      const radial = radiusA !== null && radiusB !== null ? Math.abs(radiusA - radiusB) : null
      return radial === null
        ? distanceReadout(axial, 'axial distance')
        : { ...distanceReadout(axial, 'axial distance'), extra: [distanceReadout(radial, 'radial gap')] }
    }

    const extra: Readout[] = [distanceReadout(centreDistance, 'center distance')]
    if (axial > AXIS_EPS) extra.push(distanceReadout(axial, 'axial offset'))
    if (radiusA !== null && radiusB !== null) {
      const minGap = pitch - radiusA - radiusB
      // A negative min gap is the overlap: the two circles cross.
      extra.push({ kind: 'distance', value: minGap, label: minGap < 0 ? 'overlap' : 'min gap' })
      extra.push(distanceReadout(pitch + radiusA + radiusB, 'max span'))
    }
    extra.push(...deltaExtras(ca, cb))
    return { ...distanceReadout(pitch, 'pitch'), extra }
  }),

  cell('circle', 'plane', 'axis along or square to the face: center-to-plane distance; else angle', (c, pl) => {
    const axis = axisOfCircle(c)
    if (isParallel(axis, pl.normal) || isPerpendicular(axis, pl.normal)) {
      return distanceReadout(pointToPlane(centreOf(c), pl))
    }
    return angleReadout(axis, pl.normal)
  }),

  cell('circle', 'axis', 'parallel axes: distance; else angle', (c, ax) => {
    if (isParallel(axisOfCircle(c), axisOf(ax))) {
      return distanceReadout(parallelLineDistance(centreOf(c), axisPointOf(ax), axisOfCircle(c)), 'axis distance')
    }
    return angleReadout(axisOfCircle(c), axisOf(ax))
  }),

  cell('plane', 'plane', 'parallel: distance, coplanar faces ask the kernel; else angle', (a, b) => {
    if (isParallel(a.normal, b.normal)) {
      const gap = pointToPlane(b.point, a)
      // Two coplanar faces read 0 through the infinite-plane formula; their real
      // gap (a slot's sides, two halves of a split face) is OCCT's to state. A
      // datum plane has no shape, so it keeps the analytic 0 (K3).
      if (gap <= AXIS_EPS && a.bounded && b.bounded) return { kernel: 'distance' }
      return distanceReadout(gap)
    }
    return angleReadout(a.normal, b.normal)
  }),

  cell('plane', 'axis', 'axis parallel to the plane: distance; else angle', (pl, ax) => {
    if (isPerpendicular(axisOf(ax), pl.normal)) {
      return distanceReadout(pointToPlane(axisPointOf(ax), pl), 'axis distance')
    }
    return directionPlaneAngle(axisOf(ax), pl.normal)
  }),

  cell('axis', 'axis', 'parallel axes: distance, with gaps for two radii; else angle', (a, b) => {
    if (isParallel(axisOf(a), axisOf(b))) {
      const offset = parallelLineDistance(axisPointOf(a), axisPointOf(b), axisOf(a))
      const readout = distanceReadout(offset, 'axis distance')
      const radiusA = axisRadiusOf(a)
      const radiusB = axisRadiusOf(b)
      if (offset <= AXIS_EPS) {
        // Coaxial axes: two different radii leave a radial gap between the
        // surfaces, which the axis distance alone cannot state.
        if (radiusA === null || radiusB === null) return readout
        return { ...readout, extra: [distanceReadout(Math.abs(radiusA - radiusB), 'radial gap')] }
      }
      if (radiusA === null || radiusB === null) return readout
      const minGap = offset - radiusA - radiusB
      return {
        ...readout,
        extra: [
          { kind: 'distance', value: minGap, label: minGap < 0 ? 'overlap' : 'min gap' },
          distanceReadout(offset + radiusA + radiusB, 'max span'),
        ],
      }
    }
    return angleReadout(axisOf(a), axisOf(b))
  }),
]

const PAIR_INDEX = new Map<string, PairCell>(
  PAIR_TABLE.map((c) => [c.a < c.b ? `${c.a}|${c.b}` : `${c.b}|${c.a}`, c]),
)

/**
 * The one measurement two primitives yield, or null when the pair has none.
 * Opaque and whole-body picks are kernel cells, mapped by `kernelOpFor` rather
 * than falling back to a guess built on the wrong face data.
 */
export function measurePair(a: Primitive, b: Primitive): MeasureResult {
  const classA = classOf(a)
  const classB = classOf(b)
  const kernel = kernelOpFor(classA, classB)
  if (kernel !== null) return { kernel }
  const found = PAIR_INDEX.get(classA < classB ? `${classA}|${classB}` : `${classB}|${classA}`)
  if (!found) return null
  const first = found.a === classA ? a : b
  const second = found.a === classA ? b : a
  return found.measure(first, second)
}

/**
 * The kernel op a pair of classes asks for, or null when the analytic table
 * answers it. Only a CLASS-UNKNOWN pick (a whole body, a freeform face, a
 * spline edge) reaches the kernel, and a clearance is only ever two whole
 * bodies: it answers "how far apart are these two parts", which the overlap
 * probe has to qualify first.
 */
function kernelOpFor(classA: MeasureClass, classB: MeasureClass): KernelOp | null {
  const freeA = classA === 'opaque' || classA === 'solid'
  const freeB = classB === 'opaque' || classB === 'solid'
  if (!freeA && !freeB) return null
  return classA === 'solid' && classB === 'solid' ? 'clearance' : 'distance'
}

/**
 * The one measurement a single pick states. A flat face reads its area and a
 * whole body its volume through the kernel (R2), a circular flat face its
 * diameter (R1), a curved face its diameter, an arc its radius and sweep, a
 * line its length; a vertex and a datum plane deliberately read nothing (D2).
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
      if (p.radius == null) return null
      return {
        kind: 'diameter',
        value: p.radius * 2,
        label: 'diameter',
        ...(p.length != null && { extra: [{ kind: 'length' as const, value: p.length, label: 'length' }] }),
      }
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
    case 'plane':
      // A bounded face states its area; a datum plane has no shape (R2, K3).
      return p.bounded ? { kernel: 'area' } : null
    case 'solid':
      return { kernel: 'volume' }
    case 'point':
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

// Every class, in table order. The kernel table is derived from this so it
// cannot omit a cell the dispatch function answers.
const CLASSES: readonly MeasureClass[] = [
  'point', 'line', 'circle', 'plane', 'axis', 'opaque', 'solid',
]

export interface SingleRuleRow {
  pick: string
  readout: string
}

/** The single-pick half of the readout table, shown on the Registry page. It
 *  names the same branches `measureOne` implements; keep the two together. */
export const SINGLE_RULES: readonly SingleRuleRow[] = [
  { pick: 'line (edge or sketch)', readout: 'length' },
  { pick: 'arc (an unpaired one)', readout: 'radius and sweep' },
  { pick: 'full circle, split circle on one face', readout: 'diameter' },
  { pick: 'circular flat face (disc, ring)', readout: 'outer diameter' },
  { pick: 'cylinder face', readout: 'diameter and axial length' },
  { pick: 'sphere face', readout: 'diameter' },
  { pick: 'ellipse', readout: 'major and minor radius' },
  { pick: 'cone face', readout: 'half angle' },
  { pick: 'torus face', readout: 'major and minor radius' },
  { pick: 'spline edge, partial ellipse edge', readout: 'kernel length' },
  { pick: 'flat face', readout: 'kernel area' },
  { pick: 'whole body', readout: 'kernel volume and area' },
  { pick: 'vertex, datum plane', readout: 'nothing' },
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

export interface KernelPairRuleRow extends PairRuleRow {
  op: KernelOp
}

/** The kernel half of the pair table, derived from the same dispatch function
 *  `measurePair` uses: every class pair OCCT answers, once, in table order. */
export const KERNEL_PAIR_RULES: readonly KernelPairRuleRow[] = CLASSES.flatMap((a, ai) =>
  CLASSES.slice(ai).flatMap((b) => {
    const op = kernelOpFor(a, b)
    if (op === null) return []
    return [{
      a: CLASS_LABEL[a],
      b: CLASS_LABEL[b],
      op,
      readout: op === 'clearance'
        ? 'kernel clearance, 0 when they overlap or share a face'
        : 'kernel minimum distance',
    }]
  }))
