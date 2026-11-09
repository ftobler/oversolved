// `sketch_loops_to_face` and the hole-circle canonicalization the multi-group
// extrude path leans on. This module turns 2D profile boundary-edge loops into
// a planar OCC face, and rebuilds a hole wire that is a closed chain of arcs on
// one circle as a single canonical closed-circle edge.
//
// It is split out of prismLineage.ts so the lineage/brep producer reads as
// orchestration over a small profile builder instead of carrying the whole
// loop -> wire -> face construction inline.

import type { DisposeScope } from './disposeScope'
import { extractErrorMessage, extractOccErrorMessage } from '../errors'
import { isDevBuild } from '../isDevBuild'
import {
  ANCHORED_KINDS,
  describeProfile,
  formatGap,
  formatProfileReport,
} from '../profileDiagnostics'
import type { OccModule, OccShape, OccSubShape, OccCircle } from './occTypes'
import type { PlaneLike } from '../features/shared/planes'
import {
  edgeToGeom,
  makeArcEdge,
  makeCircleEdge,
  makeLineEdge,
  makeBezierEdge,
  makeBSplineChainEdge,
  makeEllipseEdge,
  makeWire,
  makeFaceFromWire,
  wireEndpointGaps,
  type Vec3,
} from './primitives'
import { uvTo3d } from './prismGeometry'
import { syncFitSplineEnds, type LoopEdge } from '../profileLoops'
import { copyShape } from './transforms'
import { swallowUnlessTrap } from '../errors'
import { JOINT_SNAP_TOL, OCC_CONFUSION, TOL_TOPOLOGY_MERGE } from '../solverConstants'

// ─── sketch loops -> OCC face ───

const TWO_PI = 2 * Math.PI
const DEG_PER_RAD = 180 / Math.PI

/** A refusal that names the arc and carries the numbers a bug report needs. */
export interface ArcJointRefusal {
  ok: false
  code: 'parameters' | 'degenerate' | 'chord' | 'center' | 'sweep'
  edge: string
  centerShift: number
  radialError: number
  angularError: number
  message: string
}

export interface ArcJointSolution {
  ok: true
  fullTurn: boolean
  center: [number, number]
  radius: number
  angleStartDeg: number
  angleEndDeg: number
  radialError: number
  angularError: number
}

export type ArcJointResult = ArcJointSolution | ArcJointRefusal

function edgeLabel(edge: LoopEdge): string {
  const id = edge['id']
  return typeof id === 'string' && id.length > 0 ? `'${id}'` : '(no id)'
}

/** Signed sweep of two stored angles, radians, in the traversal direction. */
function storedSweepRad(a0Deg: number, a1Deg: number, ccw: boolean): number {
  const a0 = (a0Deg * Math.PI) / 180
  const a1 = (a1Deg * Math.PI) / 180
  return ccw
    ? ((a1 - a0) % TWO_PI + TWO_PI) % TWO_PI
    : -(((a0 - a1) % TWO_PI + TWO_PI) % TWO_PI)
}

function normalizeDeg(rad: number): number {
  return ((rad * DEG_PER_RAD) % 360 + 360) % 360
}

/**
 * The circle of an arc's AUTHORED radius through its two stored endpoints.
 *
 * The loop analyser merges each joint at TOL_TOPOLOGY_MERGE and hands both
 * sides the same 2D point, while OCC's own MakeWire rung is
 * Precision::Confusion (1e-7). Rebuilding the arc from its stored angles puts
 * its realized endpoint wherever those angles point, up to ~5e-7 away from the
 * merged joint, and MakeWire then drops the edge. The circle through the two
 * stored endpoints of the authored radius has both realized endpoints exactly
 * at the joint, so the wire is the shape the analyser described.
 *
 * Pure and loop-dict-only, so its guards run without WASM. `buildArcEdge` is
 * the OCC wrapper. Refuses rather than silently building a different circle
 * when an endpoint is not on the authored arc.
 */
export function arcJointCircle(edge: LoopEdge): ArcJointResult {
  const label = edgeLabel(edge)
  const center = edge['center'] as number[] | undefined
  const radius = edge['radius'] as number | undefined
  const start = edge['start'] as number[] | undefined
  const end = edge['end'] as number[] | undefined
  const a0Deg = (edge['angle_start_deg'] as number | undefined) ?? 0
  const a1Deg = (edge['angle_end_deg'] as number | undefined) ?? 360
  const ccw = (edge['ccw'] as boolean | undefined) ?? true
  const refuse = (
    code: ArcJointRefusal['code'],
    message: string,
    numbers: Partial<Pick<ArcJointRefusal, 'centerShift' | 'radialError' | 'angularError'>> = {},
  ): ArcJointRefusal => ({
    ok: false,
    code,
    edge: typeof edge['id'] === 'string' ? (edge['id'] as string) : '',
    centerShift: numbers.centerShift ?? 0,
    radialError: numbers.radialError ?? 0,
    angularError: numbers.angularError ?? 0,
    message,
  })

  // A stored span of a full turn is the shortcut, checked BEFORE deriving
  // endpoints: such an edge has start == end, so the derivation below would
  // read a zero sweep and makeArcEdge would reject it as a degenerate arc.
  if (Math.abs(a1Deg - a0Deg) >= 360 - 1e-6) {
    if (center === undefined || radius === undefined) {
      return refuse('parameters', `arc ${label} has no stored centre or radius`)
    }
    return {
      ok: true,
      fullTurn: true,
      center: [center[0], center[1]],
      radius,
      angleStartDeg: a0Deg,
      angleEndDeg: a1Deg,
      radialError: 0,
      angularError: 0,
    }
  }

  if (center === undefined || radius === undefined || radius <= 0) {
    return refuse('parameters', `arc ${label} is missing its stored centre or radius`)
  }
  // `extractFaceLoops` emits arcs from a pcurve with no 2D endpoints; there is
  // no joint to build through, so those keep the stored-angle construction.
  if (!Array.isArray(start) || !Array.isArray(end)) {
    return {
      ok: true,
      fullTurn: false,
      center: [center[0], center[1]],
      radius,
      angleStartDeg: a0Deg,
      angleEndDeg: a1Deg,
      radialError: 0,
      angularError: 0,
    }
  }
  const c0: [number, number] = [center[0], center[1]]
  const p0: [number, number] = [start[0], start[1]]
  const p1: [number, number] = [end[0], end[1]]
  const chord = Math.hypot(p1[0] - p0[0], p1[1] - p0[1])
  const radialError = Math.max(
    Math.abs(Math.hypot(p0[0] - c0[0], p0[1] - c0[1]) - radius),
    Math.abs(Math.hypot(p1[0] - c0[0], p1[1] - c0[1]) - radius),
  )
  if (!(chord > 0)) {
    return refuse(
      'degenerate',
      `arc ${label} has coincident stored endpoints; a full turn must carry its 360 degree span`,
      { radialError },
    )
  }
  if (chord > 2 * radius + TOL_TOPOLOGY_MERGE) {
    return refuse(
      'chord',
      `arc ${label} endpoints are ${formatGap(chord)} apart, more than its diameter ${formatGap(2 * radius)}`,
      { radialError },
    )
  }

  // Two circles of this radius pass through both points; the nearer stored
  // centre keeps the authored wrapping.
  const midX = (p0[0] + p1[0]) / 2
  const midY = (p0[1] + p1[1]) / 2
  const half = Math.sqrt(Math.max(0, radius * radius - (chord * chord) / 4))
  const nx = -(p1[1] - p0[1]) / chord
  const ny = (p1[0] - p0[0]) / chord
  const candidate = (side: number): [number, number] => [midX + side * half * nx, midY + side * half * ny]
  const a = candidate(1)
  const b = candidate(-1)
  const shiftA = Math.hypot(a[0] - c0[0], a[1] - c0[1])
  const shiftB = Math.hypot(b[0] - c0[0], b[1] - c0[1])
  let c: [number, number]
  let centerShift: number
  if (shiftA <= shiftB) {
    c = a
    centerShift = shiftA
  } else {
    c = b
    centerShift = shiftB
  }
  if (centerShift > JOINT_SNAP_TOL) {
    // A chord near the diameter amplifies a tiny radial error into a large
    // centre move (~sqrt(2 r dr)), which is exactly the case where the authored
    // circle cannot pass through both merged endpoints. Refuse rather than
    // silently build a visibly different circle.
    return refuse(
      'center',
      `arc ${label} stored endpoint is not on its arc: derived centre shifted ` +
      `${formatGap(centerShift)} from the stored centre, radial error ${formatGap(radialError)}`,
      { centerShift, radialError },
    )
  }

  const th0 = Math.atan2(p0[1] - c[1], p0[0] - c[0])
  const th1 = Math.atan2(p1[1] - c[1], p1[0] - c[0])
  const storedSweep = storedSweepRad(a0Deg, a1Deg, ccw)
  const jointSweep = ccw ? ((th1 - th0) % TWO_PI + TWO_PI) % TWO_PI : -(((th0 - th1) % TWO_PI + TWO_PI) % TWO_PI)
  const angularError = Math.abs(jointSweep - storedSweep)
  // An endpoint on the circle but at a grossly different angle would otherwise
  // take the arc's complement. The rung is the same joint snap distance: the
  // realised endpoint may move by at most JOINT_SNAP_TOL along the arc.
  if (angularError * radius > JOINT_SNAP_TOL) {
    return refuse(
      'sweep',
      `arc ${label} stored endpoint sits at a different angle on its arc: angular error ` +
      `${formatGap(angularError)} rad (${formatGap(angularError * radius)} at radius ${formatGap(radius)})`,
      { centerShift, radialError, angularError },
    )
  }

  return {
    ok: true,
    fullTurn: false,
    center: c,
    radius,
    angleStartDeg: normalizeDeg(th0),
    angleEndDeg: normalizeDeg(th1),
    radialError,
    angularError,
  }
}

/** A projected elliptical-arc joint and the residual the weld must cover. */
export interface EllipseJointSolution {
  angleStartDeg: number
  angleEndDeg: number
  radialError: number
  angularError: number
}

function ellipsePoint(
  center: [number, number],
  a: number,
  b: number,
  thetaRad: number,
  phi: number,
): [number, number] {
  const ax = a * Math.cos(phi)
  const ay = b * Math.sin(phi)
  return [
    center[0] + ax * Math.cos(thetaRad) - ay * Math.sin(thetaRad),
    center[1] + ax * Math.sin(thetaRad) + ay * Math.cos(thetaRad),
  ]
}

/**
 * The eccentric angles of an elliptical arc's stored endpoints. An ellipse is
 * fixed by its `theta`, `a` and `b`, so it cannot pass through two arbitrary
 * joint points; projecting each point into the stored frame and taking
 * `atan2(y / b, x / a)` is the closed form that puts the arc as close to the
 * joint as the curve allows. The residual is welded at the joint rung by the
 * caller, not silently accepted.
 */
export function ellipseJointAngles(edge: LoopEdge): EllipseJointSolution {
  const center = (edge['center'] as number[] | undefined) ?? [0, 0]
  const a = edge['a'] as number | undefined
  const b = edge['b'] as number | undefined
  const theta = ((edge['theta'] as number | undefined) ?? 0) * (Math.PI / 180)
  const start = edge['start'] as number[] | undefined
  const end = edge['end'] as number[] | undefined
  const a0Deg = (edge['angle_start_deg'] as number | undefined) ?? 0
  const a1Deg = (edge['angle_end_deg'] as number | undefined) ?? 360
  if (
    a === undefined || b === undefined || !Array.isArray(start) || !Array.isArray(end) ||
    Math.abs(a1Deg - a0Deg) >= 360 - 1e-6
  ) {
    return { angleStartDeg: a0Deg, angleEndDeg: a1Deg, radialError: 0, angularError: 0 }
  }
  const c: [number, number] = [center[0], center[1]]
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  const project = (p: number[]): { phi: number; radialError: number; angularError: number } => {
    const dx = p[0] - c[0]
    const dy = p[1] - c[1]
    // Inverse-rotate the point into the ellipse frame, then take the
    // eccentric angle from the unit-circle image.
    const x = dx * cos + dy * sin
    const y = -dx * sin + dy * cos
    const phi = Math.atan2(y / b, x / a)
    const on = ellipsePoint(c, a, b, theta, phi)
    const radialError = Math.hypot(p[0] - on[0], p[1] - on[1])
    return { phi, radialError, angularError: 0 }
  }
  const p0 = project(start)
  const p1 = project(end)
  const angleGap = (storedDeg: number, derived: number): number => {
    const stored = (storedDeg * Math.PI) / 180
    return Math.abs(((derived - stored + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI)
  }
  return {
    angleStartDeg: normalizeDeg(p0.phi),
    angleEndDeg: normalizeDeg(p1.phi),
    radialError: Math.max(p0.radialError, p1.radialError),
    angularError: Math.max(angleGap(a0Deg, p0.phi), angleGap(a1Deg, p1.phi)),
  }
}

/**
 * Move an edge's two vertex points onto the loop's joint positions and raise
 * their tolerances to `tol`. This is the targeted weld for a curve that cannot
 * be made exact (an elliptical arc): it touches only this edge's own joint
 * vertices, so a real gap far above the merge rung still refuses in makeWire.
 */
function weldEdgeEndpoints(
  oc: OccModule,
  scope: DisposeScope,
  edge: OccShape,
  start: Vec3,
  end: Vec3,
  tol: number,
): void {
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(edge, E.TopAbs_VERTEX, E.TopAbs_SHAPE))
  const builder = scope.track(new oc.BRep_Builder())
  for (; exp.More(); exp.Next()) {
    const v = scope.track(oc.TopoDS.Vertex_1(exp.Current()))
    const p = oc.BRep_Tool.Pnt(v)
    const current: Vec3 = [p.X(), p.Y(), p.Z()]
    p.delete()
    const toStart = Math.hypot(current[0] - start[0], current[1] - start[1], current[2] - start[2])
    const toEnd = Math.hypot(current[0] - end[0], current[1] - end[1], current[2] - end[2])
    const target = toStart <= toEnd ? start : end
    const point = scope.track(new oc.gp_Pnt_3(target[0], target[1], target[2]))
    builder.UpdateVertex_1(v, point, tol)
  }
}

function fullCircleOf(loop: LoopEdge[]): LoopEdge | null {
  if (loop.length < 2 || loop.some((e) => e['kind'] !== 'arc')) return null
  const c0 = loop[0]['center'] as number[] | undefined
  const r0 = loop[0]['radius'] as number | undefined
  if (c0 === undefined || r0 === undefined) return null
  for (const e of loop) {
    const c = e['center'] as number[] | undefined
    const r = e['radius'] as number | undefined
    if (c === undefined || r === undefined) return null
    if (Math.abs(r - r0) > 1e-9 || Math.abs(c[0] - c0[0]) > 1e-9 || Math.abs(c[1] - c0[1]) > 1e-9) {
      return null
    }
  }
  return {
    kind: 'arc',
    center: [...c0],
    radius: r0,
    angle_start_deg: 0.0,
    angle_end_deg: 360.0,
    ccw: true,
    start: [c0[0] + r0, c0[1]],
    end: [c0[0] + r0, c0[1]],
  }
}

/** Exported so the real-OCC profile test can read the joints the builder made. */
export function buildArcEdge(oc: OccModule, scope: DisposeScope, plane: PlaneLike, edge: LoopEdge): OccShape {
  const joint = arcJointCircle(edge)
  if (!joint.ok) throw new Error(`buildArcEdge: ${joint.message}`)
  const center3d = uvTo3d(plane, joint.center)
  const normal = plane.normal as Vec3
  const xAxis = plane.x_axis as Vec3
  const ccw = (edge['ccw'] as boolean | undefined) ?? true
  if (joint.fullTurn) {
    return makeArcEdge(oc, scope, center3d, normal, xAxis, joint.radius, 0.0, TWO_PI)
  }
  let u0 = (joint.angleStartDeg * Math.PI) / 180
  let u1 = (joint.angleEndDeg * Math.PI) / 180
  if (ccw) {
    if (u1 <= u0) u1 += TWO_PI
  } else {
    if (u0 <= u1) u0 += TWO_PI
    const tmp = u0
    u0 = u1
    u1 = tmp
  }
  return makeArcEdge(oc, scope, center3d, normal, xAxis, joint.radius, u0, u1)
}

/** A uv-plane direction lifted to 3D (no origin offset), for the ellipse axis. */
function uvDirTo3d(plane: PlaneLike, du: number, dv: number): Vec3 {
  const x = plane.x_axis
  const y = plane.y_axis
  return [du * x[0] + dv * y[0], du * x[1] + dv * y[1], du * x[2] + dv * y[2]]
}

function buildEllipseEdge(oc: OccModule, scope: DisposeScope, plane: PlaneLike, edge: LoopEdge): OccShape {
  const center3d = uvTo3d(plane, edge['center'] as number[])
  const theta = ((edge['theta'] as number | undefined) ?? 0) * (Math.PI / 180)
  const majorAxis = uvDirTo3d(plane, Math.cos(theta), Math.sin(theta))
  return makeEllipseEdge(oc, scope, center3d, plane.normal as Vec3, majorAxis, edge['a'] as number, edge['b'] as number)
}

/**
 * A sliced ellipse boundary edge: a trimmed elliptical arc over its angle span.
 * The angles are projected from the stored joint endpoints (see
 * `ellipseJointAngles`); when the projection leaves a residual over OCC's
 * confusion rung the caller welds this edge's own joint vertices.
 */
function buildEllipseArcEdge(
  oc: OccModule,
  scope: DisposeScope,
  plane: PlaneLike,
  edge: LoopEdge,
): { shape: OccShape; weld: { start: Vec3; end: Vec3 } | null; radialError: number } {
  const centerUv = (edge['center'] as number[] | undefined) ?? [0, 0]
  const center3d = uvTo3d(plane, centerUv)
  const theta = ((edge['theta'] as number | undefined) ?? 0) * (Math.PI / 180)
  const majorAxis = uvDirTo3d(plane, Math.cos(theta), Math.sin(theta))
  const a = edge['a'] as number
  const b = edge['b'] as number
  const joint = ellipseJointAngles(edge)
  const angularScale = Math.max(a, b)
  if (joint.angularError * angularScale > JOINT_SNAP_TOL) {
    // A projected endpoint at a grossly different eccentric angle would build
    // the ellipse's complement. The circular-arc builder refuses that too.
    const id = typeof edge['id'] === 'string' ? `'${edge['id']}'` : '(no id)'
    throw new Error(
      `buildEllipseArcEdge: ellipse-arc ${id} stored endpoint sits at a different eccentric ` +
      `angle (angular error ${formatGap(joint.angularError)} rad, ` +
      `${formatGap(joint.angularError * angularScale)} at scale ${formatGap(angularScale)})`,
    )
  }
  let u0 = (joint.angleStartDeg * Math.PI) / 180
  let u1 = (joint.angleEndDeg * Math.PI) / 180
  // GC_MakeArcOfEllipse needs an increasing CCW span; flip a CW edge.
  if (!((edge['ccw'] as boolean | undefined) ?? true)) {
    const t = u0
    u0 = u1
    u1 = t
  }
  if (u1 <= u0) u1 += TWO_PI
  const shape = makeEllipseEdge(oc, scope, center3d, plane.normal as Vec3, majorAxis, a, b, u0, u1)
  const start = edge['start'] as number[] | undefined
  const end = edge['end'] as number[] | undefined
  // A residual inside the merge rung is welded at the joint; one past it is
  // left for makeWire to refuse, with the edge id and the measured residual in
  // the message.
  const weld = joint.radialError > OCC_CONFUSION && joint.radialError <= TOL_TOPOLOGY_MERGE &&
    Array.isArray(start) && Array.isArray(end)
    ? { start: uvTo3d(plane, start) as Vec3, end: uvTo3d(plane, end) as Vec3 }
    : null
  return { shape, weld, radialError: joint.radialError }
}

// ANCHORED_KINDS is defined in kernel/profileLoops (re-exported by
// profileDiagnostics) so the snapper below, the loop assembler and the pure
// profile dump cannot drift apart about which edges can be moved.

function jointDist(a: number[], b: number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

/**
 * Reconcile each loop joint so adjacent edges share an exact endpoint before they
 * become OCC edges. The solver can leave a circle whose radius/center misses a
 * shared vertex by ~1e-7 (just over OCC's confusion tolerance), so the arc's
 * on-curve endpoint and the line's vertex endpoint disagree and makeWire silently
 * drops the arc. We snap the FREE side (line/spline, whose endpoint follows its
 * stored coords) onto the ANCHORED side (arc/ellipse, pinned to its curve); when
 * both sides are free we collapse them together. Joints already wider than
 * JOINT_SNAP_TOL are left for makeWire to reject. Returns cloned edges; the
 * caller's loop dicts (shared with the stored topology) are never mutated.
 */
function snapLoopJoints(loop: LoopEdge[]): LoopEdge[] {
  const out: LoopEdge[] = loop.map((e) => {
    const c: LoopEdge = { ...e }
    if (Array.isArray(e['start'])) c['start'] = [...(e['start'] as number[])]
    if (Array.isArray(e['end'])) c['end'] = [...(e['end'] as number[])]
    return c
  })
  if (out.length < 2) return out
  const isAnchored = (e: LoopEdge): boolean => ANCHORED_KINDS.has(e['kind'] as string)
  for (let i = 0; i < out.length; i++) {
    const a = out[i]
    const b = out[(i + 1) % out.length]
    const aEnd = a['end'] as number[] | undefined
    const bStart = b['start'] as number[] | undefined
    if (!Array.isArray(aEnd) || !Array.isArray(bStart)) continue
    if (jointDist(aEnd, bStart) > JOINT_SNAP_TOL) continue
    const aAnchored = isAnchored(a)
    const bAnchored = isAnchored(b)
    if (aAnchored && bAnchored) continue  // both pinned to a curve: nothing we can move
    if (aAnchored) {
      b['start'] = [...aEnd]
    } else if (bAnchored) {
      a['end'] = [...bStart]
    } else {
      b['start'] = [...aEnd]  // free/free: collapse b's start onto a's end
    }
  }
  // A fit spline is anchored to its POLES, not to its start/end, so a joint it
  // won moves nothing above. Sync its terminal poles onto the merged endpoints
  // the assembler (or this snapper) gave it, or the wire is built 5e-7 away
  // from the joint the dump calls closed.
  return out.map(syncFitSplineEnds)
}

/**
 * The joint gaps as OCC realized them, for a failure message. Best effort: this
 * runs only on a path that is already throwing, so it must never be the reason
 * anything fails, and it must never mask the real error.
 */
function realizedGapsLine(oc: OccModule, scope: DisposeScope, edges: OccShape[]): string {
  try {
    const gaps = wireEndpointGaps(oc, scope, edges)
    return `\n  gaps OCC realized at each joint: ${gaps.map(formatGap).join(', ')}`
  } catch (e) {
    swallowUnlessTrap(e)
    return ''
  }
}

/**
 * Build one loop's OCC wire. `loop` must ALREADY be snapped (see
 * `sketchLoopsToFace`): the wire this makes and the report the caller dumps have
 * to describe the same geometry, or the dump accuses joints the kernel repaired
 * and never saw.
 */
function buildWire(oc: OccModule, scope: DisposeScope, plane: PlaneLike, loop: LoopEdge[]): OccShape {
  const circle = fullCircleOf(loop)
  // Every edge below is tracked at creation and released once makeWire has
  // copied it into the wire, so a dirty feature's repeated rebuilds do not
  // stack dead boundary edges on the heap. A throw from makeWire leaves them
  // tracked: the caller's dispose() is then their owner.
  const singleEdge = (edge: OccShape): OccShape => {
    const tracked = scope.track(edge)
    let wire: OccShape
    try {
      wire = scope.track(makeWire(oc, scope, [tracked], { requireClosed: true }))
    } catch (e) {
      swallowUnlessTrap(e)
      throw new Error(`${extractOccErrorMessage(oc, e)}${realizedGapsLine(oc, scope, [tracked])}`)
    }
    scope.release(tracked)
    return wire
  }
  if (circle !== null) return singleEdge(buildArcEdge(oc, scope, plane, circle))
  // A full ellipse is a single closed boundary edge -> one ellipse-edge wire.
  if (loop.length === 1 && (loop[0]['kind'] as string) === 'ellipse') {
    return singleEdge(buildEllipseEdge(oc, scope, plane, loop[0]))
  }
  const edges: OccShape[] = []
  const welds: { shape: OccShape; start: Vec3; end: Vec3 }[] = []
  const weldNotes: string[] = []
  for (const edge of loop) {
    const kind = edge['kind'] as string
    if (kind === 'arc') {
      edges.push(scope.track(buildArcEdge(oc, scope, plane, edge)))
    } else if (kind === 'ellipse') {
      edges.push(scope.track(buildEllipseEdge(oc, scope, plane, edge)))
    } else if (kind === 'ellipse_arc') {
      const built = buildEllipseArcEdge(oc, scope, plane, edge)
      const shape = scope.track(built.shape)
      edges.push(shape)
      if (built.weld !== null) welds.push({ shape, start: built.weld.start, end: built.weld.end })
      if (built.radialError > OCC_CONFUSION) {
        weldNotes.push(
          built.weld === null
            ? `\n  ellipse-arc ${edgeLabel(edge)} endpoint projected ${formatGap(built.radialError)} ` +
              `off its curve, above the TOL_TOPOLOGY_MERGE weld rung (${formatGap(TOL_TOPOLOGY_MERGE)})`
            : `\n  ellipse-arc ${edgeLabel(edge)} endpoint projected ${formatGap(built.radialError)} ` +
              `off its curve, welded at TOL_TOPOLOGY_MERGE (${formatGap(TOL_TOPOLOGY_MERGE)})`,
        )
      }
    } else if (kind === 'spline') {
      // Cubic Bezier boundary: lift the 4-point control polygon to 3D.
      const poles = [
        uvTo3d(plane, edge['start'] as number[]),
        uvTo3d(plane, edge['c1'] as number[]),
        uvTo3d(plane, edge['c2'] as number[]),
        uvTo3d(plane, edge['end'] as number[]),
      ]
      edges.push(scope.track(makeBezierEdge(oc, scope, poles)))
    } else if (kind === 'fit_spline') {
      // One fused run of the interpolating spline: the C0 chain poles lifted to
      // 3D and the chord knots. OCC removes the interior knots to reach C2.
      const poles = (edge['poles'] as number[][]).map(p => uvTo3d(plane, p))
      const knots = edge['knots'] as number[]
      edges.push(scope.track(makeBSplineChainEdge(oc, scope, poles, knots)))
    } else if (kind === 'line' || kind === undefined) {
      const p1 = uvTo3d(plane, edge['start'] as number[])
      const p2 = uvTo3d(plane, edge['end'] as number[])
      edges.push(scope.track(makeLineEdge(oc, scope, p1, p2)))
    } else {
      // A kind this writer does not know must fail loud: silently drawing a
      // chord across it is a wrong solid, not a missing edge.
      throw new Error(`buildWire: unknown loop edge kind '${kind}'`)
    }
  }
  // An elliptical arc is fixed by its frame, so its realized endpoint cannot be
  // made exact. Weld only those joints, at the same rung the area builder
  // merged them, so a real open loop still refuses in makeWire.
  for (const weld of welds) {
    weldEdgeEndpoints(oc, scope, weld.shape, weld.start, weld.end, TOL_TOPOLOGY_MERGE)
  }
  // A profile boundary that does not close is not a profile: without this the
  // face builder takes an open chain and the extrude reports ok. The uv-space
  // dump the caller attaches says what the SKETCH asked for; these gaps say what
  // the kernel actually built, which is the pair that identifies an arc whose
  // endpoint was forced onto its ideal circle.
  let wire: OccShape
  try {
    wire = scope.track(makeWire(oc, scope, edges, { requireClosed: true }))
  } catch (e) {
    swallowUnlessTrap(e)
    throw new Error(
      `${extractOccErrorMessage(oc, e)}${weldNotes.join('')}${realizedGapsLine(oc, scope, edges)}`,
    )
  }
  for (const e of edges) scope.release(e)
  return wire
}

/**
 * The profile dump, or '' if producing it fails. A diagnostic must never become
 * the failure: on the success path a throw in here would turn a working extrude
 * into a red feature, and in the catch it would replace the real OCC error with
 * its own. `when: 'suspect'` returns '' for a clean profile, so the dev-gated
 * log stays quiet.
 */
function safeProfileReport(loops: LoopEdge[][], when: 'suspect' | 'always'): string {
  try {
    const report = describeProfile(loops)
    if (when === 'suspect' && report.verdict !== 'suspect') return ''
    return formatProfileReport(report)
  } catch (e) {
    swallowUnlessTrap(e)
    return when === 'always' ? `(profile dump unavailable: ${extractErrorMessage(e)})` : ''
  }
}

/**
 * Convert 2D profile boundary-edge loops to a planar OCC face with holes
 * (mirrors `sketch_loops_to_face`). loops[0] is the outer boundary; loops[1:]
 * are holes. A loop made entirely of arcs on one shared circle is emitted as a
 * single closed circle edge so OCC builds one cylindrical face on extrude.
 */
export function sketchLoopsToFace(
  oc: OccModule,
  scope: DisposeScope,
  loops: LoopEdge[][],
  plane: PlaneLike,
): OccShape {
  // Snap ONCE, here, so the wires below and the dump attached to a failure are
  // the same geometry. Snapping inside buildWire meant the report described the
  // pre-snap loops: it accused joints snapLoopJoints had already repaired and
  // OCC never saw, and it fired `suspect` on profiles that built perfectly.
  const snapped = loops.map(snapLoopJoints)
  try {
    const outerWire = buildWire(oc, scope, plane, snapped[0])
    const holeWires = snapped.slice(1).map((hole) => buildWire(oc, scope, plane, hole))
    // The wires live only until makeFaceFromWire copies them into the face; the
    // face keeps their curves alive via shared TShapes.
    let face: OccShape
    try {
      face = makeFaceFromWire(oc, scope, outerWire, holeWires)
    } finally {
      scope.release(outerWire)
      for (const w of holeWires) scope.release(w)
    }
    // A profile can build into a wrong-but-valid solid with no error anywhere
    // (a duplicated hole wire). Leave a trace when that happens, gated like
    // every other hot-path diagnostic so production solves stay silent.
    if (isDevBuild()) {
      const suspect = safeProfileReport(snapped, 'suspect')
      if (suspect !== '') console.warn(`sketchLoopsToFace: the profile built but looks suspect\n${suspect}`)
    }
    return face
  } catch (e) {
    // Without this the user sees an emscripten pointer, or a bare "only 3 of 4
    // edges connected", with nothing to say WHICH joint or how wide. The dump is
    // the reproduction: it is what turns "OCCT is not recognizing the shape"
    // into a paste-able bug report.
    swallowUnlessTrap(e)
    throw new Error(`${extractOccErrorMessage(oc, e)}\n${safeProfileReport(snapped, 'always')}`)
  }
}

// ─── hole-circle canonicalization ───

/**
 * If `wire` is a closed chain of arcs (or full circles) all on the same circle,
 * rebuild it as ONE closed-circle edge on that circle's own frame; else return
 * null (the caller keeps the original wire). This collapses the emergent hole
 * boundary that is split between two adjacent source regions into a single
 * canonical closed-circle edge before the prism is built, so the prism emits ONE
 * cylinder face with a deterministic seam (the circle's own X axis). A later
 * add-fuse onto this body -- which prisms the body's top face -- then inherits
 * the same seam by construction, and the fuse+clean merges cleanly (the
 * original "extrude adds a hole-bearing face back onto its own body" defect
 * that left every wall, hole included, doubled at the profile-plane seam).
 *
 * The first contributing arc's `gp_Circ` supplies the frame so the rebuilt
 * edge's seam is the underlying circle's own X axis -- independent of where the
 * partial arcs split it, hence the same for every body and every future tool.
 */
function collapseCircleWire(oc: OccModule, scope: DisposeScope, wire: OccShape): OccShape | null {
  const E = oc.TopAbs_ShapeEnum
  const edges: OccShape[] = []
  const exp = scope.track(new oc.TopExp_Explorer_2(wire, E.TopAbs_EDGE, E.TopAbs_SHAPE))
  for (; exp.More(); exp.Next()) {
    const raw = scope.track(exp.Current())
    edges.push(scope.track(oc.TopoDS.Edge_1(raw)))
  }
  if (edges.length < 2) return null

  let center: Vec3 | null = null
  let radius = 0.0
  let frameCirc: OccCircle | null = null
  const tol = 1e-6
  for (const e of edges) {
    const { ed } = edgeToGeom(oc, scope, e)
    if (ed.kind !== 'arc' && ed.kind !== 'circle') return null
    const c = ed.center as Vec3
    const r = ed.radius as number
    if (center === null) {
      center = [c[0], c[1], c[2]]
      radius = r
      const ad = scope.track(new oc.BRepAdaptor_Curve_2(e))
      frameCirc = scope.track(ad.Circle())
    } else if (
      Math.abs(c[0] - center[0]) > tol ||
      Math.abs(c[1] - center[1]) > tol ||
      Math.abs(c[2] - center[2]) > tol ||
      Math.abs(r - radius) > tol
    ) {
      return null  // mixed circles / not co-circular
    }
  }
  const circ = frameCirc as OccCircle
  // Five by-value proxies chain out of the circle here; read their
  // coordinates into plain arrays and delete the proxies BEFORE makeCircleEdge
  // runs, so a throw from makeCircleEdge cannot strand the proxies (the
  // previous delete-after call left them leaking on the throw path).
  const loc = circ.Location()
  const axis = circ.Axis()
  const axDir = axis.Direction()
  const xax1 = circ.XAxis()
  const xDir = xax1.Direction()
  const locCoords: Vec3 = [loc.X(), loc.Y(), loc.Z()]
  const axDirCoords: Vec3 = [axDir.X(), axDir.Y(), axDir.Z()]
  const xDirCoords: Vec3 = [xDir.X(), xDir.Y(), xDir.Z()]
  loc.delete()
  axis.delete()
  axDir.delete()
  xax1.delete()
  xDir.delete()
  const edge = scope.track(makeCircleEdge(oc, scope, locCoords, axDirCoords, xDirCoords, radius))
  const canonical = scope.track(makeWire(oc, scope, [edge]))
  scope.release(edge)
  return canonical
}

/**
 * Rebuild `face` so every inner (hole) wire that is a closed chain of arcs on
 * the same circle is replaced by a single closed-circle edge. The outer wire is
 * left intact (it stays a chain of partial arcs -- the peanut's outer boundary
 * uses two distinct circles and must not collapse). Returns the original face
 * unchanged when no hole needed canonicalizing, so callers can skip a redundant
 * face rebuild. Planar geometry is identical (same outer wire, same hole
 * curves), so the face's centroid and normal are preserved.
 */
export function canonicalizeFaceCircles(oc: OccModule, scope: DisposeScope, face: OccShape): OccShape {
  const E = oc.TopAbs_ShapeEnum
  const outerWire = scope.track(oc.BRepTools.OuterWire(face))
  const holes: OccShape[] = []
  const wexp = scope.track(new oc.TopExp_Explorer_2(face, E.TopAbs_WIRE, E.TopAbs_SHAPE))
  for (; wexp.More(); wexp.Next()) {
    const raw = scope.track(wexp.Current())
    const w = scope.track(oc.TopoDS.Wire_1(raw))
    if (!(w as OccSubShape).IsSame(outerWire)) holes.push(w)
  }
  const rebuilt = canonicalizeFaceCirclesWith(oc, scope, outerWire, holes)
  // Both branches return an UNTRACKED face the caller owns: the rebuilt one from
  // makeFaceFromWire, and, when nothing needed canonicalizing, a copy of the
  // entrance face rather than the entrance face itself, so the caller never has
  // to ask which branch it took.
  if (rebuilt !== null) return rebuilt
  // `copyShape` hands back the generic TopoDS_Shape wrapper; the caller prisms
  // this face and reads its normal, both of which take a TopoDS_Face and throw
  // a raw embind type error on the shape wrapper (the crossing-rectangle add
  // that re-prisms the merged entrance cap hit exactly that).
  const copied = scope.track(copyShape(oc, scope, face))
  const asFace = oc.TopoDS.Face_1(copied)
  scope.release(copied)
  return asFace
}

/**
 * Exported core of [[canonicalizeFaceCircles]]: rebuild a planar face from
 * `outerWire` + `holes` so that any hole wire that is a closed chain of arcs on
 * the same circle is replaced by a single closed-circle edge. Returns the
 * original outer+holes wrapped in `makeFaceFromWire` when at least one hole was
 * canonicalized (else returns null, so the caller can skip a redundant rebuild).
 * Exposed for the unit test that drives it with synthetic wires.
 */
export function canonicalizeFaceCirclesWith(
  oc: OccModule,
  scope: DisposeScope,
  outerWire: OccShape,
  holes: OccShape[],
): OccShape | null {
  let changed = false
  const canonicalHoles: { wire: OccShape; owned: boolean }[] = []
  for (const w of holes) {
    const canon = collapseCircleWire(oc, scope, w)
    if (canon !== null) {
      changed = true
      canonicalHoles.push({ wire: canon, owned: true })
    } else {
      canonicalHoles.push({ wire: w, owned: false })
    }
  }
  if (!changed) return null
  // The rebuilt canonical wires are folded into the face; only the wires we
  // built (owned) are released here. The caller's wires are not ours to free.
  try {
    return makeFaceFromWire(oc, scope, outerWire, canonicalHoles.map((h) => h.wire))
  } finally {
    for (const h of canonicalHoles) if (h.owned) scope.release(h.wire)
  }
}
