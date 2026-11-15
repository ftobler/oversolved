// One sampler for a resolved path spine. The sweep and the curve pattern both
// walk the edges `collectPathEdges` built, so the adaptor construction lives
// here rather than in either leaf: two samplers would be two truths about the
// same curve.
//
// `samplePath` turns the sampler into the polyline a path pattern places copies
// on: one point per sample, the cumulative arc length at each point, and the
// unit tangent there. The tangent is a central chord difference, so a corner
// reads as the angle bisector instead of favouring one side; the frame math that
// consumes it lives in kernel/features/curvePatternPlacement.ts.

import type { DisposeScope } from '../../occ/disposeScope'
import type { OccModule, OccShape } from '../../occ/occTypes'
import type { Vec3 } from '../../occ/primitives'
import type { SpineSampler } from '../sweepStations'
import { TOL_LOOP_CLOSURE } from '../../solverConstants'

/**
 * One curve adaptor per spine edge, parameterised over the edge's own range.
 * The adaptors stay in `scope` for the whole solve, so every consumer (the
 * sweep's sections, a path pattern's stations) reads the same sampling.
 */
export function spineSampler(oc: OccModule, scope: DisposeScope, spineEdges: OccShape[]): SpineSampler {
  const adaptors = spineEdges.map((edge) => {
    const curve = scope.track(new oc.BRepAdaptor_Curve_2(edge))
    return { curve, first: curve.FirstParameter(), last: curve.LastParameter() }
  })
  return {
    edgeCount: adaptors.length,
    sample(edgeIdx: number, t: number): Vec3 {
      const { curve, first, last } = adaptors[edgeIdx]
      const p = curve.Value(first + (last - first) * t)
      const out: Vec3 = [p.X(), p.Y(), p.Z()]
      p.delete()
      return out
    },
  }
}

// A frame rotates with the tangent, so the polyline has to be finer than the
// sweep's section scan (32 per edge). 96 keeps a quarter-circle's chord error
// under a micron at the sizes a sketch path reaches.
export const PATH_SAMPLES_PER_EDGE = 96

/** The polyline a path resolves to, in the chosen walk direction. */
export interface PathPolyline {
  points: Vec3[]
  // Cumulative arc length, `lengths[0]` is 0 and the last entry is `total`.
  lengths: number[]
  // The unit tangent at each point.
  tangents: Vec3[]
  total: number
  // The last point lands on the first, so the path has no ends.
  closed: boolean
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function norm(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2])
}

/** A second-order one-sided tangent at an open path's end: the first two chords
 *  read the curve's tangent far more closely than one chord does, which matters
 *  because every placement is measured against the frame at s = 0. */
function endTangent(points: Vec3[], i: number, forward: boolean): Vec3 | null {
  const last = points.length - 1
  if (last < 2) return null
  if (forward) {
    const [p0, p1, p2] = [points[i], points[i + 1], points[i + 2]]
    return [
      4 * p1[0] - p2[0] - 3 * p0[0],
      4 * p1[1] - p2[1] - 3 * p0[1],
      4 * p1[2] - p2[2] - 3 * p0[2],
    ]
  }
  const [p0, p1, p2] = [points[last], points[last - 1], points[last - 2]]
  return [3 * p0[0] - 4 * p1[0] + p2[0], 3 * p0[1] - 4 * p1[1] + p2[1], 3 * p0[2] - 4 * p1[2] + p2[2]]
}

/** The tangent at each sample. A central difference over the neighbouring
 *  chords reads a smooth curve's own tangent and makes a corner its bisector. A
 *  closed path has a neighbour across its seam, so its first and last tangents
 *  are as exact as the interior ones instead of one chord behind. */
function chordTangents(points: Vec3[], closed: boolean): Vec3[] {
  const last = points.length - 1
  const out: Vec3[] = []
  for (let i = 0; i < points.length; i++) {
    const before = i > 0
      ? sub(points[i], points[i - 1])
      : closed && last > 1 ? sub(points[0], points[last - 1]) : null
    const after = i < last
      ? sub(points[i + 1], points[i])
      : closed && last > 1 ? sub(points[1], points[0]) : null
    const d: Vec3 = before !== null && after !== null
      ? [before[0] + after[0], before[1] + after[1], before[2] + after[2]]
      : after ?? before ?? [0, 0, 1]
    const len = norm(d)
    const fallback = after ?? before
    if (len < 1e-12) {
      // Two opposite chords (a cusp) cancel; keep the one side that exists
      // rather than a zero vector the frame math cannot normalize.
      const fl = fallback === null ? 0 : norm(fallback)
      out.push(fl < 1e-12 ? [0, 0, 1] : [fallback![0] / fl, fallback![1] / fl, fallback![2] / fl])
      continue
    }
    // An open end has only one chord; the two-chord formula is far better.
    if (i === 0 || i === last) {
      const better = endTangent(points, i, i === 0)
      if (better !== null) {
        const bl = norm(better)
        if (bl > 1e-12) {
          out.push([better[0] / bl, better[1] / bl, better[2] / bl])
          continue
        }
      }
    }
    out.push([d[0] / len, d[1] / len, d[2] / len])
  }
  return out
}

/** The polyline a run of points makes: the cumulative arc lengths and the
 *  tangents. `closed` says the last point lands on the first, which makes the
 *  seam's two tangents read across it. Exported so a test can build the same
 *  polyline the kernel samples, by one rule. */
export function pathPolyline(points: Vec3[], closed: boolean): PathPolyline {
  const lengths: number[] = [0]
  for (let i = 1; i < points.length; i++) {
    lengths.push(lengths[i - 1] + norm(sub(points[i], points[i - 1])))
  }
  return {
    points,
    lengths,
    tangents: chordTangents(points, closed),
    total: lengths[lengths.length - 1] ?? 0,
    closed,
  }
}

/**
 * Sample the spine into a polyline. A path whose last point lands on its first,
 * within the sketch's own closure tolerance, is closed: that is what makes a
 * full circle behave like a loop instead of like a chain with a seam.
 */
export function samplePath(sampler: SpineSampler, samplesPerEdge = PATH_SAMPLES_PER_EDGE): PathPolyline {
  const points: Vec3[] = []
  for (let e = 0; e < sampler.edgeCount; e++) {
    for (let k = 0; k <= samplesPerEdge; k++) {
      // The joint is the previous edge's last sample: re-adding it would put a
      // zero-length chord in the polyline.
      if (e > 0 && k === 0) continue
      points.push(sampler.sample(e, k / samplesPerEdge))
    }
  }
  const last = points.length - 1
  const closed = last > 1 && norm(sub(points[last], points[0])) <= TOL_LOOP_CLOSURE
  return pathPolyline(points, closed)
}

/** The same polyline walked from its far end: `reverse` measures the spacing
 *  from the other end of the path. */
export function reversePath(path: PathPolyline): PathPolyline {
  const last = path.points.length - 1
  const points: Vec3[] = []
  const lengths: number[] = []
  const tangents: Vec3[] = []
  for (let i = 0; i <= last; i++) {
    points.push(path.points[last - i])
    lengths.push(path.total - path.lengths[last - i])
    const t = path.tangents[last - i]
    tangents.push([-t[0], -t[1], -t[2]])
  }
  return { points, lengths, tangents, total: path.total, closed: path.closed }
}
