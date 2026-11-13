/**
 * Lower a sampled projected curve to the sketch entity that can follow it.
 *
 * A curve with no exact 2D entity (a tilted conic arc, a partial ellipse, a
 * sampled B-spline body edge) used to become one cubic Bezier. One cubic holds
 * a quarter arc to within a fraction of a thousandth of its radius, but a 180
 * to 270 degree sweep, a partial ellipse over pi, or a B-spline with several
 * inflections misses by percent of its size, and the projected entity is
 * pinned, so the user cannot correct it. This module tries the single cubic
 * first and keeps it when its deviation from the true projected curve stays
 * within tolerance; otherwise it emits a `fit_spline` through adaptively
 * chosen fit points, which the solver, the area builder and OCC already handle
 * as one C2 chain.
 *
 * The tolerance is relative to the curve's own size, so the same rule judges a
 * 1 mm fillet and a 1 m fetched curve on the same footing. In absolute terms it
 * never goes under the vertex-merge rung: a deviation that small is invisible
 * to the area builder anyway.
 */

import { TOL_TOPOLOGY_MERGE } from '@/kernel/solverConstants'
import { fitCubicBezier } from './bezierFit'
import {
  bezierClosestT,
  bezierEval,
  interpolateFitSpline,
  MAX_FIT_POINTS,
  type FitSplineCurve,
  type Pt,
} from './fitSpline'

export type ProjectedCurveKind = 'spline' | 'fit_spline'

export interface ProjectedCurve {
  kind: ProjectedCurveKind
  params: number[]
  /** Set when the adaptive fit reached the fit-point cap without meeting the
   *  tolerance. The caller surfaces it as a projection warning; the geometry is
   *  still the best fit found, never a refusal. */
  warning?: string
}

/**
 * How far a one-cubic fit may stray from the true curve, as a fraction of the
 * curve's bounding-box diagonal. The value sits between the worst single cubic
 * that is still worth keeping and the first one that is not, both measured on
 * this branch: at a 60 degree tilt a 60 degree sweep misses by 1.22e-3 of its
 * size and stays a `spline`; a tilted half arc misses by 2.07e-3 and switches
 * to a `fit_spline`. The 30 degree tilted quarter arc (5.7e-4) keeps its kind,
 * so an existing document's common projected arc does not change shape.
 *
 * The measured spectrum behind the number, relative to the curve's size:
 * 30 deg tilt quarter arc 5.7e-4, 60 deg tilt and sweep arc 1.22e-3, tilted
 * half arc 2.07e-3, half ellipse 2.24e-3, 60 deg tilt quarter arc and quarter
 * ellipse 2.88e-3, 270 deg arc 1.58e-2, three-inflection B-spline 1.48e-1. A
 * single sampled cubic fits to 1.3e-5, so the B-spline payload a body edge
 * carries still lowers to one `spline`.
 */
export const PROJECTED_CURVE_FIT_TOL = 1.5e-3

/** Dense truth samples per conic sweep. The 32-point legacy fit grid stays the
 *  seed for the one-cubic trial, so an existing quarter arc keeps its params. */
export const CONIC_TRUTH_STEPS = 128

/** Curve size: the diagonal of the sample bounding box. Unlike the end-to-end
 *  chord it stays meaningful for a closed loop, whose ends coincide. */
export function curveScale(points: readonly Pt[]): number {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const p of points) {
    if (p[0] < minX) minX = p[0]
    if (p[0] > maxX) maxX = p[0]
    if (p[1] < minY) minY = p[1]
    if (p[1] > maxY) maxY = p[1]
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return 0
  return Math.hypot(maxX - minX, maxY - minY)
}

function pointDistance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

function pointToCubicDistance(p: Pt, ctrl: readonly Pt[]): number {
  const t = bezierClosestT(ctrl, p)
  return pointDistance(p, bezierEval(ctrl, t))
}

/** Largest distance from a true sample to its closest point on the cubic. */
export function maxDeviationToCubic(samples: readonly Pt[], ctrl: readonly Pt[]): number {
  let worst = 0
  for (const p of samples) worst = Math.max(worst, pointToCubicDistance(p, ctrl))
  return worst
}

/** Largest distance from a true sample to the interpolating spline. */
export function maxDeviationToFitSpline(samples: readonly Pt[], points: readonly Pt[]): number {
  const curve = interpolateFitSpline(points)
  let worst = 0
  for (const p of samples) worst = Math.max(worst, curve.closest(p).distance)
  return worst
}

/** True when the sampled curve returns to its start within `tolerance` and has
 *  enough samples to be a loop rather than a short segment. */
export function isClosedLoop(points: readonly Pt[], tolerance: number): boolean {
  return points.length >= 3 && pointDistance(points[0], points[points.length - 1]) <= tolerance
}

/** Drop a sample repeated exactly at the previous position. The closing point of
 *  a loop repeats the FIRST point, not its predecessor, so it survives. */
function dropRepeatedNeighbours(points: readonly Pt[]): Pt[] {
  const out: Pt[] = []
  for (const p of points) {
    const prev = out[out.length - 1]
    if (prev && pointDistance(prev, p) === 0) continue
    out.push([p[0], p[1]])
  }
  return out
}

interface SpanWorst {
  // Index of the span (piece) in the current fit.
  span: number
  // Candidate sample index furthest from that span.
  index: number
  deviation: number
}

/** The worst true sample of each span, restricted to that span's own cubic. A
 *  sample is never matched against a neighbouring piece, which would let a bad
 *  span hide behind a good neighbour. */
function worstSpan(curve: FitSplineCurve, chosen: readonly number[], samples: readonly Pt[]): SpanWorst {
  let worst: SpanWorst = { span: 0, index: chosen[0], deviation: -1 }
  for (let k = 0; k + 1 < chosen.length; k++) {
    const ctrl = curve.piece(k)
    for (let i = chosen[k] + 1; i < chosen[k + 1]; i++) {
      const d = pointToCubicDistance(samples[i], ctrl)
      if (d > worst.deviation) worst = { span: k, index: i, deviation: d }
    }
  }
  return worst
}

/**
 * Choose fit points from the true samples until every span follows the curve to
 * `tolerance`. A span that still misses is split at its worst sample, which is
 * deterministic: the first sample at the maximum distance wins, and the walk
 * runs spans then samples in order. Returns the best point set found and whether
 * it met the tolerance before the cap.
 *
 * The cap is `MAX_FIT_POINTS`, so the flat block is at most 128 scalars, under
 * `MAX_INITIAL_PARAMS` (132) even before any end handle is added.
 */
export function adaptiveFitPoints(
  samples: readonly Pt[],
  tolerance: number,
): { points: Pt[]; converged: boolean } {
  const candidates = dropRepeatedNeighbours(samples)
  if (candidates.length < 2) return { points: candidates, converged: false }
  const chosen = [0, candidates.length - 1]
  let best: Pt[] = chosen.map(i => candidates[i])
  while (true) {
    const points = chosen.map(i => candidates[i])
    let curve: FitSplineCurve
    try {
      curve = interpolateFitSpline(points)
    } catch {
      // Degenerate point set (coincident span the drop could not see): the last
      // usable fit is the answer, and the caller still emits a curve.
      return { points: best, converged: false }
    }
    const worst = worstSpan(curve, chosen, candidates)
    if (worst.deviation <= tolerance) return { points, converged: true }
    if (chosen.length >= MAX_FIT_POINTS) return { points, converged: false }
    best = points
    // Every remaining span is a single sample wide: the candidate set itself
    // cannot describe the curve more finely.
    if (worst.index <= chosen[worst.span] || worst.index >= chosen[worst.span + 1]) {
      return { points, converged: false }
    }
    chosen.splice(worst.span + 1, 0, worst.index)
  }
}

/** Make a closed source a closed spline: the last fit point is the first, so the
 *  chain ends exactly where it starts and the closing joint is one point. */
function mergeEnds(points: readonly Pt[]): Pt[] {
  if (points.length < 3) return points.map(p => [p[0], p[1]])
  const last = points[points.length - 1]
  if (pointDistance(last, points[0]) === 0) return points.map(p => [p[0], p[1]])
  const merged = points.map(p => [p[0], p[1]] as Pt)
  merged[merged.length - 1] = [points[0][0], points[0][1]]
  // Merging moves the closing point, so a penultimate point sitting on the
  // start would make the last span zero length; keep the sampled end instead.
  if (pointDistance(merged[merged.length - 2], merged[merged.length - 1]) === 0) {
    return points.map(p => [p[0], p[1]])
  }
  return merged
}

/**
 * Lower one sampled projected curve. `truth` is a dense sample of the source in
 * the sketch frame, in traversal order (a closed loop repeats its first point);
 * `fitSamples` is the sample set the legacy one-cubic fit used, so the common
 * quarter arc keeps byte-identical params.
 *
 * Returns null only when there is no curve to lower (fewer than two points).
 */
export function lowerProjectedCurve(
  truth: readonly Pt[],
  fitSamples: readonly Pt[],
): ProjectedCurve | null {
  const samples = dropRepeatedNeighbours(truth)
  if (samples.length < 2) return null
  const tolerance = Math.max(PROJECTED_CURVE_FIT_TOL * curveScale(samples), TOL_TOPOLOGY_MERGE)
  const closed = isClosedLoop(samples, tolerance)
  if (!closed) {
    const cubic = fitCubicBezier(fitSamples.map(p => [p[0], p[1]] as Pt))
    // A cubic through a straight or nearly straight sample set is the right
    // answer even when it is the degenerate straight spelling.
    if (cubic) {
      const ctrl: Pt[] = [
        [cubic[0], cubic[1]], [cubic[2], cubic[3]],
        [cubic[4], cubic[5]], [cubic[6], cubic[7]],
      ]
      if (maxDeviationToCubic(samples, ctrl) <= tolerance) return { kind: 'spline', params: cubic }
    }
  }
  const fit = adaptiveFitPoints(samples, tolerance)
  const points = closed ? mergeEnds(fit.points) : fit.points
  if (points.length < 2) return null
  const params: number[] = []
  for (const p of points) params.push(p[0], p[1])
  if (fit.converged) return { kind: 'fit_spline', params }
  return {
    kind: 'fit_spline',
    params,
    warning: `projected curve fit used ${points.length} fit points without meeting its tolerance; `
      + 'the closest fit is kept',
  }
}
