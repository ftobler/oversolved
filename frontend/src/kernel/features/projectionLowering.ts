/**
 * Pure projection lowering: resolve a B-rep (or sketch) source payload into 3D
 * geometry, then project it onto a sketch plane as 2D entity params. Extracted
 * from `sketch.ts` so it can be unit-tested without the WASM solver and reused
 * by every solve path.
 *
 * The lowerer supports all edge kinds the OCC reader emits -- line, circle,
 * arc, ellipse, spline -- plus orientation-aware conic projection: a 3D circle
 * or ellipse whose plane is not parallel to the sketch plane projects as an
 * *ellipse*, not a circle with the wrong radius. A conic seen edge-on has a
 * zero-width projection, so it lowers to its silhouette line instead (its true
 * shape); a declared `point` on a curved source is that curve's centre.
 */

import { fitCubicBezier } from '@/utils/geometry/bezierFit'
import { dot as dot3, cross as cross3 } from '@/utils/vec3'
import { worldToSketch2d, sketchToWorld2d } from './shared/planes'
import type { PlaneLike } from './shared/planes'
import { isFaceRestriction } from '@/kernel/occ/primitives'
import { TOL_LENGTH_SLACK, TOL_TOPOLOGY_MERGE } from '@/kernel/solverConstants'

type Dict = Record<string, unknown>

/** A sketch-plane frame: origin + in-plane basis (and implied normal). */
export interface PlaneFrame {
  origin: number[]
  x_axis: number[]
  y_axis: number[]
}

export interface Resolved3dGeometry {
  kindH: 'point' | 'line' | 'circle' | 'arc' | 'ellipse' | 'spline'
  data: Dict
}

/** A lowered projection: the resolved entity kind plus its 2D params. The kind
 *  can differ from the declared kind: a tilted circle lowers to an ellipse, an
 *  edge-on one to a line, and a declared point on a curve to its centre. Arc
 *  params are always the counter-clockwise spelling, the only one the sketch
 *  arc entity has. */
interface ProjectedParams {
  kind: string
  params: number[]
}

function len3(a: number[]): number {
  return Math.hypot(a[0], a[1], a[2])
}

function normalize3(a: number[]): number[] {
  const l = len3(a)
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]
}

function len2d(v: number[]): number {
  return Math.hypot(v[0], v[1])
}

function dot2d(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1]
}

/**
 * Principal semi-axes of an ellipse given two conjugate semi-diameters (the 2D
 * projections of two perpendicular radii). Returns `[a, b, thetaDeg]` with
 * `a >= b` and `theta` the major-axis rotation in degrees (the convention the
 * Rust ellipse residual expects). Standard result: the extremal-radius angle is
 * `t0 = 0.5 * atan2(2 d1.d2, |d1|^2 - |d2|^2)`.
 */
function conjugateToAxes(d1: number[], d2: number[]): [number, number, number] {
  const d1d1 = d1[0] * d1[0] + d1[1] * d1[1]
  const d2d2 = d2[0] * d2[0] + d2[1] * d2[1]
  const d1d2 = d1[0] * d2[0] + d1[1] * d2[1]
  const t0 = 0.5 * Math.atan2(2 * d1d2, d1d1 - d2d2)
  const c = Math.cos(t0)
  const s = Math.sin(t0)
  const axA = [d1[0] * c + d2[0] * s, d1[1] * c + d2[1] * s]
  const axB = [-d1[0] * s + d2[0] * c, -d1[1] * s + d2[1] * c]
  let a = len2d(axA)
  let b = len2d(axB)
  let theta = Math.atan2(axA[1], axA[0])
  if (b > a) {
    [a, b] = [b, a]
    theta = Math.atan2(axB[1], axB[0])
  }
  return [a, b, theta * (180 / Math.PI)]
}

/**
 * Project a 3D circle/ellipse (center + two perpendicular semi-axis directions)
 * onto the sketch plane as an ellipse. `dirA`/`dirB` are unit directions scaled
 * by `radA`/`radB`. Returns `[cx, cy, a, b, thetaDeg]`.
 */
function conicToEllipseParams(
  center: number[],
  dirA: number[],
  radA: number,
  dirB: number[],
  radB: number,
  plane: PlaneFrame,
): number[] {
  const c2d = worldToSketch2d(center, plane)
  const uA = normalize3(dirA)
  const uB = normalize3(dirB)
  const pA = worldToSketch2d([center[0] + uA[0] * radA, center[1] + uA[1] * radA, center[2] + uA[2] * radA], plane)
  const pB = worldToSketch2d([center[0] + uB[0] * radB, center[1] + uB[1] * radB, center[2] + uB[2] * radB], plane)
  const d1 = [pA[0] - c2d[0], pA[1] - c2d[1]]
  const d2 = [pB[0] - c2d[0], pB[1] - c2d[1]]
  const [a, b, thetaDeg] = conjugateToAxes(d1, d2)
  return [c2d[0], c2d[1], a, b, thetaDeg]
}

/** Orientation-aware circle->ellipse projection (exported for tests). */
export function circleToEllipseParams(
  center: number[],
  radius: number,
  axis: number[],
  x_axis: number[],
  plane: PlaneFrame,
): number[] {
  const u = x_axis
  const v = cross3(axis, x_axis)  // the circle's in-plane perpendicular radius dir
  return conicToEllipseParams(center, u, radius, v, radius, plane)
}

/** True when a 3D plane normal is (anti)parallel to the sketch plane normal. */
function isParallelToPlane(axis: number[], plane: PlaneFrame): boolean {
  const pn = normalize3(cross3(plane.x_axis, plane.y_axis))
  const an = normalize3(axis)
  return Math.abs(dot3(an, pn)) >= 0.9999
}

/** An in-plane unit direction for an angle in degrees. */
function dirAt(thetaDeg: number): number[] {
  const t = thetaDeg * (Math.PI / 180)
  return [Math.cos(t), Math.sin(t)]
}

/** The 2D components of a world direction in the sketch frame. */
function dirTo2d(u: number[], plane: PlaneFrame): number[] {
  return [dot3(u, plane.x_axis), dot3(u, plane.y_axis)]
}

/**
 * True when a projected conic is seen edge-on: its minor semi-axis has
 * collapsed to (or under) the area builder's vertex-merge tolerance. Testing
 * the projected width rather than the tilt angle also catches a large circle a
 * hair off edge-on, whose sliver ellipse the area builder would choke on just
 * the same.
 */
function isEdgeOn(ellipseParams: number[]): boolean {
  return ellipseParams[3] <= TOL_TOPOLOGY_MERGE
}

/** The silhouette of a full projected conic: the segment along its major axis,
 *  whose midpoint is the projected centre by symmetry. The direction is
 *  canonicalised so start/end cannot swap as the source rotates through the
 *  branch cut, and a collapsed (zero major axis) conic has no line to give, so
 *  the caller reports a projection error instead of storing a zero-length
 *  entity. */
function conicSilhouetteLine(ellipseParams: number[]): ProjectedParams | null {
  const [cx, cy, a] = ellipseParams
  const [dx, dy] = dirAt(ellipseParams[4])
  if (!(a > 0)) return null
  return canonicalLine(cx - a * dx, cy - a * dy, cx + a * dx, cy + a * dy)
}

/**
 * Spell a line with a stable endpoint order: left to right, or upward when it
 * is vertical. The segment is the same either way; the stable order keeps a
 * `start`/`end` vertex ref (and the document hash) from swapping when a source
 * rotates through the branch cut between the two spellings. A horizontal delta
 * under the length-slack rung is numerical noise from the angle derivation, so
 * it reads as vertical rather than deciding the order on its sign.
 */
function canonicalLine(x0: number, y0: number, x1: number, y1: number): ProjectedParams {
  const dx = x1 - x0
  const flip = Math.abs(dx) > TOL_LENGTH_SLACK ? dx < 0 : y1 < y0
  return { kind: 'line', params: flip ? [x1, y1, x0, y0] : [x0, y0, x1, y1] }
}

/**
 * The silhouette of an edge-on arc-like sweep: sample the curve, fold the
 * sweep's interior projected extrema into the sample set (the grid misses them,
 * and a folding sweep reaches its extent exactly at one), and emit the segment
 * between the smallest and largest projected coordinate along `dir`.
 *
 * The ends are the true covered extent, not the source's projected ends: an arc
 * sweeping across the edge-on extremum projects out and back over the same
 * segment, and that segment is what the user sees. A sweep that gives no extent
 * (a zero-radius source or a zero-length sweep) has no line, so it lowers to a
 * projection error rather than a zero-length entity.
 *
 * The arc convention is counter-clockwise from `a0` to `a1`, so a sweep whose
 * end angle is below its start wraps once through 2*pi. The wrap-adjusted end
 * is computed once and both the sample grid and the extrema window read it, so
 * a seam-crossing arc cannot be sampled backwards.
 */
function sampledSilhouetteLine(
  pointAt: (t: number) => number[],
  sweep: { a0: number; a1: number; phase: number },
  c2d: number[],
  dir: number[],
  plane: PlaneFrame,
): ProjectedParams | null {
  const { a0, a1, phase } = sweep
  const N = 32
  const TWO_PI = 2 * Math.PI
  const end = a1 >= a0 ? a1 : a1 + TWO_PI
  const angles: number[] = []
  for (let i = 0; i <= N; i++) angles.push(a0 + (end - a0) * (i / N))
  // The projected coordinate along `dir` is a sinusoid, so its extrema sit at
  // phase + k*pi; fold each into [a0, a0 + 2*pi) in one step and keep the ones
  // the sweep actually covers.
  for (const k of [0, 1]) {
    const t = a0 + (((phase + k * Math.PI - a0) % TWO_PI) + TWO_PI) % TWO_PI
    if (t <= end) angles.push(t)
  }
  let tMin = Infinity
  let tMax = -Infinity
  for (const t of angles) {
    const p = worldToSketch2d(pointAt(t), plane)
    const s = (p[0] - c2d[0]) * dir[0] + (p[1] - c2d[1]) * dir[1]
    if (s < tMin) tMin = s
    if (s > tMax) tMax = s
  }
  if (!(tMax - tMin > 0)) return null
  return canonicalLine(
    c2d[0] + tMin * dir[0], c2d[1] + tMin * dir[1],
    c2d[0] + tMax * dir[0], c2d[1] + tMax * dir[1],
  )
}

/** A 3D frame lookup for a sketch id: the `_pt_<sketchId>` registration, which
 *  carries the full plane frame (origin, axes and normal). The lowerer stays
 *  repository-free so it can be unit tested; the solve passes the lookup. */
export type SketchFrameLookup = (sketchId: string) => PlaneLike | null

/**
 * Extract 3D geometry from a repository payload (mirrors `_resolve_source_geometry`).
 *
 * `sketchFrame` lifts a whole sketch entity: `postRegister` registers
 * `<sketch>/<eid>` as `{external_params, kind, sketch_id}`, whose params are 2D
 * in the owning sketch's frame. A cross-sketch snap or projection of such an
 * entity had no branch and resolved nothing. The lift mirrors
 * `resolveCircularReference` in `shared/directionQuery.ts` (centre through the
 * frame, the frame normal as the circle axis): line, circle and arc lower; a
 * spline or ellipse payload is left unresolved (its 2D params do not describe a
 * curve this projection can rebuild), which the sketch solve reports as a
 * projection error naming the constraint.
 */
export function resolve3dGeometry(data: Dict, sketchFrame?: SketchFrameLookup): Resolved3dGeometry | null {
  const dataType = (data.type as string) ?? ''
  // Every face kind projects as its own centroid point; a cone, sphere or torus
  // payload used to miss this branch and project nothing at all.
  if (isFaceRestriction(dataType)) {
    const pt = data.centroid || data.origin || [0, 0, 0]
    return { kindH: 'point', data: { point: pt } }
  }
  if (dataType === 'edge' || dataType === 'straightedge') {
    const edgeKind = (data.kind as string) ?? ''
    if (edgeKind === 'circle' || edgeKind === 'arc') {
      const center = data.center as number[] | undefined
      const radius = data.radius as number | undefined
      if (!center || radius == null) return null
      if (edgeKind === 'circle') {
        // axis/x_axis carried through so projectTo2d can detect a tilted circle
        // (which must lower to an ellipse, not a wrong-radius circle).
        return { kindH: 'circle', data: { center, radius, axis: data.axis, x_axis: data.x_axis } }
      }
      return {
        kindH: 'arc',
        data: {
          center,
          radius,
          axis: data.axis,
          x_axis: data.x_axis,
          angle_start: data.angle_start,
          angle_end: data.angle_end,
        },
      }
    }
    if (edgeKind === 'ellipse') {
      const center = data.center as number[] | undefined
      const a = data.a as number | undefined
      const b = data.b as number | undefined
      if (!center || a == null || b == null) return null
      return {
        kindH: 'ellipse',
        data: {
          center, a, b, axis: data.axis, x_axis: data.x_axis,
          angle_start: data.angle_start, angle_end: data.angle_end,
        },
      }
    }
    if (edgeKind === 'spline') {
      // A sampled spline/NURBS edge carries its polyline points; the lowerer
      // fits a cubic Bezier to them after projecting to the sketch plane.
      const points = data.points as number[][] | undefined
      if (!points || points.length < 2) return null
      return { kindH: 'spline', data: { points } }
    }
    const start = data.start as number[] | undefined
    const end = data.end as number[] | undefined
    if (!start || !end) return null
    return { kindH: 'line', data: { start, end } }
  }
  if (dataType === 'vertex') {
    // B-rep vertices carry coords under `origin` (builder.ts); slash-registry
    // points use flat x/y/z (postRegister.ts). Read both, else the B-rep shape
    // falls through to [0,0,0] and projects the document origin.
    const pt = (data.origin as number[] | undefined) ?? [
      (data.x as number) ?? 0,
      (data.y as number) ?? 0,
      (data.z as number) ?? 0,
    ]
    return { kindH: 'point', data: { point: pt } }
  }
  if ('external_params' in data) {
    const sketchId = (data.sketch_id as string | undefined) ?? ''
    const frame = sketchId !== '' ? sketchFrame?.(sketchId) ?? null : null
    const params = data.external_params as number[] | undefined
    const kind = (data.kind as string | undefined) ?? ''
    if (!frame || !params || params.length < 2) return null
    // The first pair is the line start or the curve centre, whichever the kind
    // reads it as.
    const p0 = sketchToWorld2d([params[0], params[1]], frame)
    const xAxis = frame.x_axis
    if (kind === 'line') {
      if (params.length < 4) return null
      return {
        kindH: 'line',
        data: { start: p0, end: sketchToWorld2d([params[2], params[3]], frame) },
      }
    }
    if (kind === 'circle') {
      if (params.length < 3) return null
      const normal = cross3(frame.x_axis, frame.y_axis)
      return { kindH: 'circle', data: { center: p0, radius: params[2], axis: normal, x_axis: [...xAxis] } }
    }
    if (kind === 'arc') {
      // The document stores arc angles in degrees; the 3D payload every other
      // projection branch reads carries radians.
      if (params.length < 5) return null
      const normal = cross3(frame.x_axis, frame.y_axis)
      return {
        kindH: 'arc',
        data: {
          center: p0,
          radius: params[2],
          axis: normal,
          x_axis: [...xAxis],
          angle_start: (params[3] * Math.PI) / 180,
          angle_end: (params[4] * Math.PI) / 180,
        },
      }
    }
    // A spline or ellipse source has no 2D-params-to-3D lift here; refusing it
    // leaves the caller's `projection_errors` naming the dead projection.
    return null
  }
  // Fallback: payloads from the slash registry (hole points, etc.)
  if ('x' in data || 'y' in data || 'z' in data) {
    const x = (data.x as number) ?? 0
    const y = (data.y as number) ?? 0
    const z = (data.z as number) ?? 0
    return { kindH: 'point', data: { point: [x, y, z] } }
  }
  if (data.origin) {
    return { kindH: 'point', data: { point: data.origin as number[] } }
  }
  return null
}

/**
 * Project resolved 3D geometry to entity params on the sketch plane. Branches on
 * the *resolved* geometry kind (`g3d.kindH`): the declared entity kind is only a
 * pick-time hint and can disagree with the source (e.g. after this very function
 * promotes a circle to an ellipse, the doc entity becomes an ellipse while its
 * source edge is still a circle). The one declared-kind rule lives in the
 * caller, not here: `lowerProjectionConstraints` substitutes `projectCenter` for
 * a projection declared `point` on a curved source. Returns the resolved kind
 * plus params; a tilted circle lowers to 'ellipse', a partial ellipse to
 * 'spline', and an edge-on curve to its silhouette 'line'.
 */
export function projectTo2d(
  g3d: Resolved3dGeometry,
  plane: PlaneFrame,
): ProjectedParams | null {
  const { kindH, data } = g3d
  if (kindH === 'point') {
    const pt = data.point as number[]
    return { kind: 'point', params: worldToSketch2d(pt, plane) }
  }
  if (kindH === 'line') {
    const s2d = worldToSketch2d(data.start as number[], plane)
    const e2d = worldToSketch2d(data.end as number[], plane)
    return { kind: 'line', params: [...s2d, ...e2d] }
  }
  if (kindH === 'circle') {
    const center = data.center as number[]
    const radius = data.radius as number
    const axis = data.axis as number[] | undefined
    const x_axis = data.x_axis as number[] | undefined
    // Tilted circle -> ellipse. Without an axis (sketch-local source) keep it a
    // circle, which is correct for a coplanar projection. Seen edge-on the
    // ellipse is zero-width, so it lowers to its silhouette line.
    if (axis && x_axis && !isParallelToPlane(axis, plane)) {
      const params = circleToEllipseParams(center, radius, axis, x_axis, plane)
      return isEdgeOn(params) ? conicSilhouetteLine(params) : { kind: 'ellipse', params }
    }
    const c2d = worldToSketch2d(center, plane)
    return { kind: 'circle', params: [...c2d, radius] }
  }
  if (kindH === 'ellipse') {
    const center = data.center as number[]
    const a = data.a as number
    const b = data.b as number
    const axis = (data.axis as number[] | undefined) ?? [0, 0, 1]
    const x_axis = (data.x_axis as number[] | undefined) ?? [1, 0, 0]
    const v = cross3(axis, x_axis)  // minor-axis direction in the ellipse plane
    const a0 = data.angle_start as number | undefined
    const a1 = data.angle_end as number | undefined
    const full = a0 == null || a1 == null || Math.abs(Math.abs(a1 - a0) - 2 * Math.PI) < 1e-3
    const u = normalize3(x_axis)
    const vn = normalize3(v)
    const pointAt = (t: number): number[] => {
      const ca = a * Math.cos(t)
      const sb = b * Math.sin(t)
      return [
        center[0] + ca * u[0] + sb * vn[0],
        center[1] + ca * u[1] + sb * vn[1],
        center[2] + ca * u[2] + sb * vn[2],
      ]
    }
    const fullParams = conicToEllipseParams(center, x_axis, a, v, b, plane)
    if (full) {
      return isEdgeOn(fullParams) ? conicSilhouetteLine(fullParams) : { kind: 'ellipse', params: fullParams }
    }
    // A partial elliptical arc has no 2D ellipse-arc entity: sample the arc and
    // fit a cubic Bezier, mirroring the generic spline-edge projection. Seen
    // edge-on it is its covered silhouette instead.
    if (isEdgeOn(fullParams)) {
      const dir = dirAt(fullParams[3])
      const u2 = dirTo2d(u, plane)
      const v2 = dirTo2d(vn, plane)
      const phase = Math.atan2(b * dot2d(v2, dir), a * dot2d(u2, dir))
      return sampledSilhouetteLine(pointAt, { a0: a0 as number, a1: a1 as number, phase },
        [fullParams[0], fullParams[1]], dir, plane)
    }
    const N = 32
    const pts2d: [number, number][] = []
    for (let i = 0; i <= N; i++) {
      const t = (a0 as number) + ((a1 as number) - (a0 as number)) * (i / N)
      pts2d.push(worldToSketch2d(pointAt(t), plane) as [number, number])
    }
    const params = fitCubicBezier(pts2d)
    return params ? { kind: 'spline', params } : null
  }
  if (kindH === 'arc') {
    const center = data.center as number[]
    const radius = data.radius as number
    const c2d = worldToSketch2d(center, plane)

    if (typeof data.angle_start === 'number' && typeof data.angle_end === 'number' && !data.axis) {
      // Sketch-to-sketch arc projection (source arc has 2D angles already).
      return { kind: 'arc', params: [...c2d, radius, data.angle_start as number, data.angle_end as number] }
    }

    // 3D body arc: resolve endpoints in 3D, project to 2D, then compute
    // angles relative to the projected center. Mirrors `_project_3d_arc_to_params`.
    const axis = data.axis as number[]
    const ax = data.x_axis as number[]
    const a0 = data.angle_start as number
    const a1 = data.angle_end as number
    if (!axis || !ax || a0 == null || a1 == null) return null

    const normal = axis
    const y_axis = cross3(normal, ax)
    const pointAt = (t: number): number[] => {
      const c = Math.cos(t)
      const s = Math.sin(t)
      return [
        center[0] + radius * (c * ax[0] + s * y_axis[0]),
        center[1] + radius * (c * ax[1] + s * y_axis[1]),
        center[2] + radius * (c * ax[2] + s * y_axis[2]),
      ]
    }

    if (!isParallelToPlane(axis, plane)) {
      // A tilted source arc projects to an ELLIPTICAL arc. Seen edge-on that
      // ellipse has zero width, so the arc lowers to the segment it covers: an
      // arc sweeping across the edge-on extremum folds back over that segment.
      const fullParams = circleToEllipseParams(center, radius, axis, ax, plane)
      if (isEdgeOn(fullParams)) {
        const dir = dirAt(fullParams[3])
        const phase = Math.atan2(dot2d(dirTo2d(y_axis, plane), dir), dot2d(dirTo2d(ax, plane), dir))
        return sampledSilhouetteLine(pointAt, { a0, a1, phase },
          [fullParams[0], fullParams[1]], dir, plane)
      }
      // Otherwise there is no 2D ellipse-arc entity, and a circular arc through
      // the projected endpoints would invent a radius (the chord endpoints are
      // at different distances from the projected center) and an arbitrary
      // side. Sample and fit a cubic Bezier instead, mirroring the
      // partial-ellipse branch above.
      const N = 32
      const pts2d: [number, number][] = []
      for (let i = 0; i <= N; i++) {
        pts2d.push(worldToSketch2d(pointAt(a0 + (a1 - a0) * (i / N)), plane) as [number, number])
      }
      const params = fitCubicBezier(pts2d)
      return params ? { kind: 'spline', params } : null
    }

    const s2d = worldToSketch2d(pointAt(a0), plane)
    const e2d = worldToSketch2d(pointAt(a1), plane)
    // Degree slots: the sketch arc convention is degrees everywhere (solver
    // residuals apply to_radians, previews multiply by pi/180), so the atan2
    // results must be converted -- raw radians pinned every projected arc at
    // ~1.57 degrees of sweep.
    const sa = Math.atan2(s2d[1] - c2d[1], s2d[0] - c2d[0]) * (180 / Math.PI)
    const ea = Math.atan2(e2d[1] - c2d[1], e2d[0] - c2d[0]) * (180 / Math.PI)
    const r2d = len2d([s2d[0] - c2d[0], s2d[1] - c2d[1]])
    // An anti-parallel source axis mirrors the arc onto the plane, so the 2D
    // sweep runs clockwise from sa to ea. The sketch arc entity has no winding:
    // the solver, the area builder and every preview read a0 -> a1
    // counter-clockwise, so the mirrored arc is emitted as the same quarter
    // read the other way round (its start is the source edge's end).
    const mirrored = dot3(normalize3(axis), normalize3(cross3(plane.x_axis, plane.y_axis))) <= 0
    return { kind: 'arc', params: mirrored ? [...c2d, r2d, ea, sa] : [...c2d, r2d, sa, ea] }
  }
  if (kindH === 'spline') {
    // Any sampled 3D curve (spline/NURBS) projects to 2D points, then a cubic
    // Bezier is least-squares fit to them -> the 8-param spline entity.
    const pts3d = data.points as number[][] | undefined
    if (!pts3d || pts3d.length < 2) return null
    const pts2d = pts3d.map((p) => worldToSketch2d(p, plane) as [number, number])
    const params = fitCubicBezier(pts2d)
    return params ? { kind: 'spline', params } : null
  }
  return null
}

/**
 * Project the centre of a curved source. A projection declared `point` on a
 * circle, arc or ellipse means that curve's centre, which stays reachable in
 * any orientation, edge-on included (where the curve itself lowers to a line
 * and its vertex keys disappear).
 *
 * Returns null for every other resolved kind, so the resolved kind keeps
 * winning: a declared point on a line is still that line.
 */
export function projectCenter(g3d: Resolved3dGeometry, plane: PlaneFrame): ProjectedParams | null {
  if (g3d.kindH !== 'circle' && g3d.kindH !== 'arc' && g3d.kindH !== 'ellipse') return null
  const center = g3d.data.center as number[] | undefined
  if (!center) return null
  return { kind: 'point', params: worldToSketch2d(center, plane) }
}
