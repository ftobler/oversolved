// PURE -- no doc mutation, no Three.js scene objects. The even-odd segment soup
// two sketch rules share: the offset side rule decides which side of a loop is
// bounded, and the corner fillet decides which side of each line carries
// material. Keeping one sampler here is what stops the two from disagreeing
// about a profile boundary.
//
// Sampling uses the same polyline samplers the profile builder and the draw
// preview use, so a probe sits on a chord the user can see rather than on a
// second, differently tessellated approximation.

import { sampleBezier, sampleEllipse } from './sketchSamplers'
import { fitSplineFromParams } from './fitSpline'

export type ProbePoint = [number, number]
export type ProbeSegment = [ProbePoint, ProbePoint]

export interface ProfileSource {
  id: string
  kind: string
  params: readonly number[]
  handles?: 'start' | 'end' | 'both'
}

// Arcs and circles are polygonized for the inside test. An even count puts a
// vertex on the arc's mid angle, the point the side probe starts from, so the
// probe sits on the true curve rather than on a chord.
const ARC_PIECES = 64
const SPLINE_PIECES = 32
const FIT_SPLINE_PIECES_PER_SPAN = 8

function arcSweepDeg(a0: number, a1: number): number {
  const sweep = (((a1 - a0) % 360) + 360) % 360
  return sweep === 0 ? 360 : sweep
}

function arcPoint(cx: number, cy: number, r: number, deg: number): ProbePoint {
  const t = (deg * Math.PI) / 180
  return [cx + r * Math.cos(t), cy + r * Math.sin(t)]
}

function polylineSegments(points: ReadonlyArray<readonly [number, number, number]>): ProbeSegment[] {
  const out: ProbeSegment[] = []
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]
    const b = points[i + 1]
    if (!Number.isFinite(a[0]) || !Number.isFinite(a[1]) || !Number.isFinite(b[0]) || !Number.isFinite(b[1])) continue
    out.push([[a[0], a[1]], [b[0], b[1]]])
  }
  return out
}

function fitSplinePolyline(source: ProfileSource): ProbeSegment[] | null {
  try {
    const curve = fitSplineFromParams(source.params, source.handles)
    const segments: ProbeSegment[] = []
    const knots = curve.knots
    for (let span = 0; span + 1 < knots.length; span++) {
      let previous = curve.eval(knots[span])
      for (let step = 1; step <= FIT_SPLINE_PIECES_PER_SPAN; step++) {
        const u = knots[span] + ((knots[span + 1] - knots[span]) * step) / FIT_SPLINE_PIECES_PER_SPAN
        const point = curve.eval(u)
        segments.push([previous, point])
        previous = point
      }
    }
    return segments
  } catch {
    return null
  }
}

/**
 * The profile segments one entity contributes, or null when its block cannot
 * be sampled. Null is a refusal, not an empty shape: a fillet that cannot see
 * where the material is must say so by name instead of guessing. A point (and
 * any kind with no boundary) contributes no segments.
 */
export function segmentsOf(source: ProfileSource): ProbeSegment[] | null {
  const p = source.params
  if (source.kind === 'point') return []
  if (source.kind === 'line') {
    if (p.length < 4 || !p.slice(0, 4).every(Number.isFinite)) return null
    return [[[p[0], p[1]], [p[2], p[3]]]]
  }
  if (source.kind === 'circle' || source.kind === 'arc') {
    const needed = source.kind === 'arc' ? 5 : 3
    if (p.length < needed || !p.slice(0, needed).every(Number.isFinite)) return null
    const [cx, cy, r] = p
    if (r <= 0) return null
    const a0 = source.kind === 'arc' ? p[3] : 0
    const sweep = source.kind === 'arc' ? arcSweepDeg(p[3], p[4]) : 360
    const out: ProbeSegment[] = []
    for (let i = 0; i < ARC_PIECES; i++) {
      out.push([
        arcPoint(cx, cy, r, a0 + (sweep * i) / ARC_PIECES),
        arcPoint(cx, cy, r, a0 + (sweep * (i + 1)) / ARC_PIECES),
      ])
    }
    return out
  }
  if (source.kind === 'ellipse') {
    if (p.length < 5 || !p.slice(0, 5).every(Number.isFinite)) return null
    if (p[2] <= 0 || p[3] <= 0) return null
    return polylineSegments(sampleEllipse(p[0], p[1], p[2], p[3], p[4]))
  }
  if (source.kind === 'spline') {
    if (p.length < 8 || !p.slice(0, 8).every(Number.isFinite)) return null
    return polylineSegments(sampleBezier([p[0], p[1]], [p[2], p[3]], [p[4], p[5]], [p[6], p[7]], SPLINE_PIECES))
  }
  if (source.kind === 'fit_spline') return fitSplinePolyline(source)
  return null
}

/** Even-odd inside test against an unordered segment soup (a +x ray). */
export function inside(point: ProbePoint, segments: readonly ProbeSegment[]): boolean {
  let crossings = 0
  for (const [a, b] of segments) {
    // Half-open in y, so a ray through a shared vertex counts it once.
    if ((a[1] > point[1]) === (b[1] > point[1])) continue
    const x = a[0] + ((point[1] - a[1]) / (b[1] - a[1])) * (b[0] - a[0])
    if (x > point[0]) crossings++
  }
  return crossings % 2 === 1
}

/** The bounding-box diagonal of a segment soup, the scale the side probes use. */
export function probeExtent(segments: readonly ProbeSegment[]): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [a, b] of segments) {
    for (const q of [a, b]) {
      minX = Math.min(minX, q[0]); maxX = Math.max(maxX, q[0])
      minY = Math.min(minY, q[1]); maxY = Math.max(maxY, q[1])
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return 1
  return Math.max(1, Math.hypot(maxX - minX, maxY - minY))
}
