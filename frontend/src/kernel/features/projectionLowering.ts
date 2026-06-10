/**
 * Pure projection lowering: resolve a B-rep (or sketch) source payload into 3D
 * geometry, then project it onto a sketch plane as 2D entity params. Extracted
 * from `sketch.ts` so it can be unit-tested without the WASM solver and reused
 * by every solve path.
 *
 * The lowerer supports all edge kinds the OCC reader emits -- line, circle,
 * arc, ellipse, spline -- plus orientation-aware circle projection: a 3D circle
 * whose plane is not parallel to the sketch plane projects as an *ellipse*, not
 * a circle with the wrong radius.
 */

import { fitCubicBezier } from '@/utils/geometry/bezierFit'

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
 *  can differ from the declared kind (a tilted circle lowers to an ellipse). */
export interface ProjectedParams {
  kind: string
  params: number[]
}

function dot3(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function sub3(a: number[], b: number[]): number[] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function cross3(a: number[], b: number[]): number[] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function len3(a: number[]): number {
  return Math.hypot(a[0], a[1], a[2])
}

function normalize3(a: number[]): number[] {
  const l = len3(a)
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]
}

/** Project a 3D point onto a plane frame, returning [u, v] 2D coordinates. */
export function project3dTo2d(xyz: number[], plane: PlaneFrame): number[] {
  const v = sub3(xyz, plane.origin)
  return [dot3(v, plane.x_axis), dot3(v, plane.y_axis)]
}

function len2d(v: number[]): number {
  return Math.hypot(v[0], v[1])
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
  const c2d = project3dTo2d(center, plane)
  const uA = normalize3(dirA)
  const uB = normalize3(dirB)
  const pA = project3dTo2d([center[0] + uA[0] * radA, center[1] + uA[1] * radA, center[2] + uA[2] * radA], plane)
  const pB = project3dTo2d([center[0] + uB[0] * radB, center[1] + uB[1] * radB, center[2] + uB[2] * radB], plane)
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

/** Extract 3D geometry from a repository payload (mirrors `_resolve_source_geometry`). */
export function resolve3dGeometry(data: Dict, _sourceQuery: string): Resolved3dGeometry | null {
  const dataType = (data.type as string) ?? ''
  if (dataType === 'face' || dataType === 'flatface' || dataType === 'cylinderface') {
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
    const x = (data.x as number) ?? 0
    const y = (data.y as number) ?? 0
    const z = (data.z as number) ?? 0
    return { kindH: 'point', data: { point: [x, y, z] } }
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

/** Project resolved 3D geometry to entity params on the sketch plane. Returns
 *  the resolved kind (a tilted circle lowers to 'ellipse') plus the params. */
export function projectTo2d(
  kind: string,
  g3d: Resolved3dGeometry,
  plane: PlaneFrame,
): ProjectedParams | null {
  const { data } = g3d
  if (kind === 'point') {
    const pt = data.point as number[]
    return { kind: 'point', params: project3dTo2d(pt, plane) }
  }
  if (kind === 'line') {
    const s2d = project3dTo2d(data.start as number[], plane)
    const e2d = project3dTo2d(data.end as number[], plane)
    return { kind: 'line', params: [...s2d, ...e2d] }
  }
  if (kind === 'circle') {
    const center = data.center as number[]
    const radius = data.radius as number
    const axis = data.axis as number[] | undefined
    const x_axis = data.x_axis as number[] | undefined
    // Tilted circle -> ellipse. Without an axis (sketch-local source) keep it a
    // circle, which is correct for a coplanar projection.
    if (axis && x_axis && !isParallelToPlane(axis, plane)) {
      return { kind: 'ellipse', params: circleToEllipseParams(center, radius, axis, x_axis, plane) }
    }
    const c2d = project3dTo2d(center, plane)
    return { kind: 'circle', params: [...c2d, radius] }
  }
  if (kind === 'ellipse') {
    const center = data.center as number[]
    const a = data.a as number
    const b = data.b as number
    const axis = (data.axis as number[] | undefined) ?? [0, 0, 1]
    const x_axis = (data.x_axis as number[] | undefined) ?? [1, 0, 0]
    const v = cross3(axis, x_axis)  // minor-axis direction in the ellipse plane
    const a0 = data.angle_start as number | undefined
    const a1 = data.angle_end as number | undefined
    const full = a0 == null || a1 == null || Math.abs(Math.abs(a1 - a0) - 2 * Math.PI) < 1e-3
    if (full) {
      return { kind: 'ellipse', params: conicToEllipseParams(center, x_axis, a, v, b, plane) }
    }
    // A partial elliptical arc has no 2D ellipse-arc entity: sample the arc and
    // fit a cubic Bezier, mirroring the generic spline-edge projection.
    const u = normalize3(x_axis)
    const vn = normalize3(v)
    const N = 32
    const pts2d: [number, number][] = []
    for (let i = 0; i <= N; i++) {
      const t = a0 + (a1 - a0) * (i / N)
      const ca = a * Math.cos(t)
      const sb = b * Math.sin(t)
      const p3 = [
        center[0] + ca * u[0] + sb * vn[0],
        center[1] + ca * u[1] + sb * vn[1],
        center[2] + ca * u[2] + sb * vn[2],
      ]
      pts2d.push(project3dTo2d(p3, plane) as [number, number])
    }
    const params = fitCubicBezier(pts2d)
    return params ? { kind: 'spline', params } : null
  }
  if (kind === 'arc') {
    const center = data.center as number[]
    const radius = data.radius as number
    const c2d = project3dTo2d(center, plane)

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

    const axNorm = [ax[0], ax[1], ax[2]] as number[]
    const normal = axis
    const y_axis = cross3(normal, axNorm)

    const cos0 = Math.cos(a0)
    const sin0 = Math.sin(a0)
    const cos1 = Math.cos(a1)
    const sin1 = Math.sin(a1)
    const start3d = [
      center[0] + radius * (cos0 * axNorm[0] + sin0 * y_axis[0]),
      center[1] + radius * (cos0 * axNorm[1] + sin0 * y_axis[1]),
      center[2] + radius * (cos0 * axNorm[2] + sin0 * y_axis[2]),
    ]
    const end3d = [
      center[0] + radius * (cos1 * axNorm[0] + sin1 * y_axis[0]),
      center[1] + radius * (cos1 * axNorm[1] + sin1 * y_axis[1]),
      center[2] + radius * (cos1 * axNorm[2] + sin1 * y_axis[2]),
    ]

    const s2d = project3dTo2d(start3d, plane)
    const e2d = project3dTo2d(end3d, plane)

    const sa = Math.atan2(s2d[1] - c2d[1], s2d[0] - c2d[0])
    const ea = Math.atan2(e2d[1] - c2d[1], e2d[0] - c2d[0])
    const r2d = len2d([s2d[0] - c2d[0], s2d[1] - c2d[1]])
    return { kind: 'arc', params: [...c2d, r2d, sa, ea] }
  }
  if (kind === 'spline') {
    // Any sampled 3D curve (spline/NURBS) projects to 2D points, then a cubic
    // Bezier is least-squares fit to them -> the 8-param spline entity.
    const pts3d = data.points as number[][] | undefined
    if (!pts3d || pts3d.length < 2) return null
    const pts2d = pts3d.map((p) => project3dTo2d(p, plane) as [number, number])
    const params = fitCubicBezier(pts2d)
    return params ? { kind: 'spline', params } : null
  }
  return null
}
