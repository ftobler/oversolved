// Sampling bundle EdgeCurves into polylines: the "B-rep feeling tier 1" edge
// overlay is nothing more than a polyline through these points. Pure geometry,
// no three.js, no camera, no store, so it unit-tests without a viewport.
//
// A curve missing its parametric fields degrades to the straight chord between
// its endpoints instead of throwing. Such a curve can only come from a bundle
// cached before those fields existed, and a bundle is a derivable artifact: a
// chord where an arc belongs is fixed by the next rebuild, a thrown error in
// the render tree takes the whole scene down.

import type { EdgeCurve } from '@/kernel/partBundle'
import type { Vec3 } from '@/utils/transform3d'
import { cross } from '@/utils/vec3'

/** Segments per full turn. An arc gets a share proportional to its sweep. */
export const DEFAULT_CURVE_RESOLUTION = 64

const TWO_PI = Math.PI * 2

function normalize(v: Vec3): Vec3 | null {
  const len = Math.hypot(v[0], v[1], v[2])
  if (!(len > 1e-12)) return null
  return [v[0] / len, v[1] / len, v[2] / len]
}

function isFiniteVec(v: readonly number[] | undefined): v is Vec3 {
  return !!v && Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2])
}

/** Segments a sweep is divided into, scaled from the full-turn resolution. */
export function segmentCount(sweep: number, resolution: number): number {
  return Math.max(2, Math.round(resolution * Math.abs(sweep) / TWO_PI))
}

function chord(curve: EdgeCurve): Vec3[] {
  return [[...curve.endpoints[0]], [...curve.endpoints[1]]]
}

/**
 * p(t) = center + a*cos(t)*u + b*sin(t)*v, with v = axis x u. A circle is the
 * a == b case, so both conics share one sweep. Matches the basis convention of
 * the part editor's buildEdgeSegments (bodyGeometry.ts) and of the endpoints
 * baked by toEdgeCurve, so a sampled arc starts and ends exactly on them.
 */
function sampleConic(curve: EdgeCurve, resolution: number): Vec3[] {
  const a = curve.radius ?? NaN
  const b = curve.kind === 'ellipse' ? (curve.minor_radius ?? NaN) : a
  const t0 = curve.angle_start ?? NaN
  const t1 = curve.angle_end ?? NaN
  if (!isFiniteVec(curve.axis) || !isFiniteVec(curve.x_axis)) return chord(curve)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return chord(curve)
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return chord(curve)

  const u = normalize(curve.x_axis)
  const axis = normalize(curve.axis)
  if (!u || !axis) return chord(curve)
  const v = normalize(cross(axis, u))
  if (!v) return chord(curve)  // x_axis parallel to axis: the plane is degenerate

  const c = curve.point
  const sweep = t1 - t0
  const segs = segmentCount(sweep, resolution)
  const pts: Vec3[] = []
  for (let i = 0; i <= segs; i++) {
    const t = t0 + sweep * (i / segs)
    const ca = a * Math.cos(t)
    const sb = b * Math.sin(t)
    pts.push([
      c[0] + ca * u[0] + sb * v[0],
      c[1] + ca * u[1] + sb * v[1],
      c[2] + ca * u[2] + sb * v[2],
    ])
  }
  return pts
}

/** The polyline approximating one curve: N points, N-1 segments. */
export function sampleEdgeCurve(curve: EdgeCurve, resolution: number = DEFAULT_CURVE_RESOLUTION): Vec3[] {
  switch (curve.kind) {
    case 'line':
      return chord(curve)
    case 'b-spline':
      // The bundle already tessellated the spline; resolution cannot refine it.
      return curve.points && curve.points.length >= 2
        ? curve.points.map(p => [...p] as Vec3)
        : chord(curve)
    case 'circle':
    case 'ellipse':
      return sampleConic(curve, resolution)
  }
}

export interface IndexedCurveSegments {
  // Flat [x0,y0,z0, x1,y1,z1, ...] segment pairs for a THREE.LineSegments buffer.
  positions: Float32Array
  // Which curve each segment came from, so a pick on a segment names its edge.
  segmentToCurve: Uint32Array
}

/**
 * Sample every curve and keep the segment -> curve join. The ID layer needs it:
 * a hit lands on one segment and must resolve to the edge entity that owns it,
 * and a dropped degenerate segment must not shift its neighbours' ownership.
 *
 * Non-finite points are dropped segment-wise: one bad vertex from a degenerate
 * curve must not stretch a line across the scene.
 */
export function buildIndexedCurveSegments(
  curves: EdgeCurve[],
  resolution: number = DEFAULT_CURVE_RESOLUTION,
): IndexedCurveSegments {
  const parts: number[] = []
  const owners: number[] = []
  curves.forEach((curve, curveIndex) => {
    const pts = sampleEdgeCurve(curve, resolution)
    for (let i = 0; i < pts.length - 1; i++) {
      if (!isFiniteVec(pts[i]) || !isFiniteVec(pts[i + 1])) continue
      parts.push(...pts[i], ...pts[i + 1])
      owners.push(curveIndex)
    }
  })
  return { positions: new Float32Array(parts), segmentToCurve: Uint32Array.from(owners) }
}

/** The visible overlay's buffer: the same sampling, minus the ownership join. */
export function buildCurveSegments(
  curves: EdgeCurve[],
  resolution: number = DEFAULT_CURVE_RESOLUTION,
): Float32Array {
  return buildIndexedCurveSegments(curves, resolution).positions
}
