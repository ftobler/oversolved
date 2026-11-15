// The curve pattern's placement law, pure: it takes the sampled path (points,
// arc lengths, tangents) and decides where each instance sits and how it turns.
// No OCC, so the spacing and orientation rules unit-test against analytic
// paths; the kernel leaf (curvePattern.ts) only resolves the path and turns
// these placements into gp_Trsf copies.
//
// Instance 0 is the source, in place. The path is anchored at its START (or at
// its far end with `reverse`): instance i sits at an arc length measured from
// there, and its placement is the rigid map F(s_i) * F(0)^-1, so the offset
// between the source and the path start is carried along exactly as it is in
// every other CAD path pattern. The source need not touch the path.
//
// Spacing:
// - equal, open: s_i = i * L / (count - 1), so the last instance lands on the
//   path's end. equal, closed: s_i = i * L / count, so no instance lands on the
//   start twice.
// - distance: s_i = i * distance. On an open path an instance past the end is
//   dropped (the caller warns once); on a closed path s wraps modulo L, and a
//   wrap that lands on another instance is refused as a coincidence.
//
// Frames F(s) = (T, N, B) at origin P(s):
// - tangent: a rotation-minimizing frame, propagated from s = 0 by double
//   reflection (Wang et al., 2008). A Frenet frame would spin the copies at an
//   inflection (the normal flips with the curvature sign); the RMF keeps the
//   normal continuous, so a helix-like path carries its copies without a flip.
// - normal_to: T with its B component removed, then (T_perp, B x T_perp, B).
//   The copies turn only about B. A station where the path runs along B has no
//   T_perp and is refused by name with its instance index.
// - fixed: no rotation at all, a pure translation by P(s_i) - P(0).

import type { Transform3D } from '@/types/cad'
import { composeTransforms, invertTransform, makeTransform, quatNormalize, type Quat } from '@/utils/transform3d'
import { reversePath, type PathPolyline } from './shared/pathSampler'

export type Vec3 = [number, number, number]

export type CurveSpacing = 'equal' | 'distance'
export type CurveOrientation = 'tangent' | 'normal_to' | 'fixed'

export interface CurvePlacementInput {
  path: PathPolyline
  // The kept instance numbers, ascending and 1-based: 0 is the source.
  indices: readonly number[]
  count: number
  spacing: CurveSpacing
  // Arc length between neighbours, read in `distance` mode only.
  distance: number
  reverse: boolean
  orientation: CurveOrientation
  // The unit direction `normal_to` turns about, resolved by the caller.
  normal: Vec3 | null
}

export interface CurvePlacement {
  index: number
  // The rigid map that carries the source onto this instance.
  transform: Transform3D
  // Arc length from the chosen path end, for the result fields and messages.
  station: number
}

export interface CurvePlacementResult {
  placements: CurvePlacement[]
  // Instances dropped because the spacing ran past an open path's end.
  dropped: number[]
  // Millimetres between neighbours: the authored distance, or L split by count.
  spacing: number
  pathLength: number
  closed: boolean
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function addScaled(a: Vec3, b: Vec3, s: number): Vec3 {
  return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s]
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2])
}

/** Unit vector, or the fallback when the input is too short to normalize. */
function unit(a: Vec3, fallback: Vec3): Vec3 {
  const len = length(a)
  return len < 1e-12 ? fallback : [a[0] / len, a[1] / len, a[2] / len]
}

/** A deterministic unit vector perpendicular to `n`, so the frame's first
 *  normal is the same on every solve (its choice cancels in F(s)F(0)^-1). */
function perpendicular(n: Vec3): Vec3 {
  const seed: Vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
  return unit(cross(n, seed), [0, 1, 0])
}

/**
 * Transport a normal from one frame to the next along the chord between them:
 * one double-reflection step. Reflecting the normal about the chord's
 * perpendicular bisector plane and then about the plane bisecting the two
 * tangents keeps the frame rotation-minimal, which is what stops a copy from
 * spinning where the path's curvature changes sign.
 */
function transportNormal(pa: Vec3, ta: Vec3, na: Vec3, pb: Vec3, tb: Vec3): Vec3 {
  const v1 = sub(pb, pa)
  const c1 = dot(v1, v1)
  if (c1 < 1e-18) return na
  const rL = addScaled(na, v1, (-2 * dot(v1, na)) / c1)
  const tL = addScaled(ta, v1, (-2 * dot(v1, ta)) / c1)
  const v2 = sub(tb, tL)
  const c2 = dot(v2, v2)
  if (c2 < 1e-18) return unit(rL, na)
  return unit(addScaled(rL, v2, (-2 * dot(v2, rL)) / c2), na)
}

/** The rotation-minimizing normal at every sample of the path. */
function rmfNormals(path: PathPolyline): Vec3[] {
  const normals: Vec3[] = [perpendicular(path.tangents[0])]
  for (let i = 1; i < path.points.length; i++) {
    normals.push(transportNormal(
      path.points[i - 1], path.tangents[i - 1], normals[i - 1],
      path.points[i], path.tangents[i],
    ))
  }
  return normals
}

/** The sample interval holding arc length `s` and how far into it `s` sits. */
function locate(path: PathPolyline, s: number): { index: number; u: number } {
  const last = path.points.length - 1
  if (s <= 0) return { index: 0, u: 0 }
  if (s >= path.total) return { index: Math.max(0, last - 1), u: 1 }
  let lo = 0
  let hi = last
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (path.lengths[mid] <= s) lo = mid
    else hi = mid
  }
  const span = path.lengths[hi] - path.lengths[lo]
  return { index: lo, u: span > 1e-12 ? (s - path.lengths[lo]) / span : 0 }
}

interface StationFrame {
  point: Vec3
  tangent: Vec3
  normal: Vec3
}

/** The path point at arc length `s`, linear between the two samples around it. */
function pointAt(path: PathPolyline, s: number): Vec3 {
  const { index, u } = locate(path, s)
  const a = path.points[index]
  const b = path.points[Math.min(index + 1, path.points.length - 1)]
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]
}

/** The frame at arc length `s`, interpolating the point and tangent and
 *  transporting the normal the short way from the sample before it. */
function frameAt(path: PathPolyline, normals: Vec3[], s: number): StationFrame {
  const { index, u } = locate(path, s)
  const a = path.points[index]
  const point = pointAt(path, s)
  const ta = path.tangents[index]
  const tb = path.tangents[Math.min(index + 1, path.tangents.length - 1)]
  const tangent = unit([ta[0] + (tb[0] - ta[0]) * u, ta[1] + (tb[1] - ta[1]) * u, ta[2] + (tb[2] - ta[2]) * u], ta)
  const normal = u === 0 ? normals[index] : transportNormal(a, ta, normals[index], point, tangent)
  return { point, tangent, normal }
}

/** The rotation whose columns are the frame's axes (the image of x, y and z). */
function quatFromBasis(u1: Vec3, u2: Vec3, u3: Vec3): Quat {
  const m00 = u1[0], m10 = u1[1], m20 = u1[2]
  const m01 = u2[0], m11 = u2[1], m21 = u2[2]
  const m02 = u3[0], m12 = u3[1], m22 = u3[2]
  const trace = m00 + m11 + m22
  let q: Quat
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s]
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]
  }
  return quatNormalize(q)
}

/** The frame at `s` as a placement, in the orientation the user chose. */
function frameTransform(
  path: PathPolyline,
  orientation: CurveOrientation,
  normalRef: Vec3 | null,
  normals: Vec3[],
  s: number,
  index: number,
): Transform3D {
  if (orientation === 'fixed') {
    // No rotation at all: the copy keeps the source's orientation and only
    // travels to its station.
    return makeTransform(pointAt(path, s), [0, 0, 0, 1])
  }
  const frame = frameAt(path, normals, s)
  if (orientation === 'normal_to') {
    const b = unit(normalRef ?? [0, 0, 1], [0, 0, 1])
    const along = addScaled(frame.tangent, b, -dot(frame.tangent, b))
    if (length(along) < 1e-6) {
      throw new Error(
        `curve_pattern: instance ${index} sits where the path runs along the normal; ` +
        'pick another orientation or a path that crosses it',
      )
    }
    const u1 = unit(along, [1, 0, 0])
    return makeTransform(frame.point, quatFromBasis(u1, cross(b, u1), b))
  }
  // tangent: the rotation-minimizing frame; B = T x N completes it.
  return makeTransform(frame.point, quatFromBasis(frame.tangent, frame.normal, cross(frame.tangent, frame.normal)))
}

function formatMm(value: number): string {
  return String(Number(value.toFixed(2)))
}

/** The warning one dropped run of instances earns: a range where the indices
 *  are contiguous, so a skipped instance in the middle does not make the
 *  message claim an instance the user already left out. */
export function pastEndWarning(dropped: readonly number[], pathLength: number): string | null {
  if (dropped.length === 0) return null
  const sorted = [...dropped].sort((a, b) => a - b)
  const runs: string[] = []
  let start = sorted[0]
  let prev = sorted[0]
  for (const index of sorted.slice(1)) {
    if (index === prev + 1) {
      prev = index
      continue
    }
    runs.push(start === prev ? String(start) : `${start}..${prev}`)
    start = index
    prev = index
  }
  runs.push(start === prev ? String(start) : `${start}..${prev}`)
  const noun = sorted.length === 1 ? 'instance' : 'instances'
  return `${noun} ${runs.join(', ')} run${sorted.length === 1 ? 's' : ''} past the path end ` +
    `(length ${formatMm(pathLength)} mm)`
}

/**
 * Place every kept instance on the path. Throws where the law refuses (a
 * non-positive distance, a wrap onto another instance, a normal_to station on
 * the normal); an instance past an open path's end is reported in `dropped` so
 * the caller can warn once and mark the feature partial.
 */
export function placeOnPath(input: CurvePlacementInput): CurvePlacementResult {
  const path = input.reverse ? reversePath(input.path) : input.path
  const closed = path.closed
  const total = path.total
  if (!(total > 0)) throw new Error('curve_pattern: the path has no length')

  if (input.spacing === 'distance' && !(input.distance > 0)) {
    throw new Error(`curve_pattern: distance must be greater than zero, got ${input.distance}`)
  }

  // s_i for the kept instances, in index order.
  const stations: { index: number; s: number }[] = []
  const dropped: number[] = []
  for (const index of input.indices) {
    if (input.spacing === 'distance') {
      const raw = index * input.distance
      if (closed) {
        stations.push({ index, s: raw % total })
        continue
      }
      if (raw > total + 1e-9) {
        dropped.push(index)
        continue
      }
      stations.push({ index, s: Math.min(raw, total) })
      continue
    }
    // equal: the count includes the source's own slot.
    const divisor = closed ? input.count : input.count - 1
    if (divisor <= 0) continue
    stations.push({ index, s: (index * total) / divisor })
  }

  // A wrapped instance that lands on another one would stack two copies.
  if (closed && input.spacing === 'distance') {
    const near = Math.max(1e-6, total * 1e-9)
    const placed: { index: number; s: number }[] = [{ index: 0, s: 0 }]
    for (const station of stations) {
      for (const earlier of placed) {
        const delta = Math.abs(station.s - earlier.s)
        const wrapped = Math.min(delta, Math.abs(total - delta))
        if (wrapped < near) {
          throw new Error(
            `curve_pattern: instance ${station.index} lands on instance ${earlier.index} ` +
            `(distance ${formatMm(input.distance)} mm over a ${formatMm(total)} mm closed path); ` +
            'lower the count or change the distance',
          )
        }
      }
      placed.push(station)
    }
  }

  const normals = input.orientation === 'fixed' ? [] : rmfNormals(path)
  const frame = (s: number, index: number): Transform3D =>
    frameTransform(path, input.orientation, input.normal, normals, s, index)
  const base = frame(0, 0)
  const placements = stations.map((station) => ({
    index: station.index,
    // F(s_i) composed with F(0)^-1: the copy's own placement, offset included.
    transform: composeTransforms(frame(station.s, station.index), invertTransform(base)),
    station: station.s,
  }))

  const spacing = input.spacing === 'distance'
    ? input.distance
    : closed
      ? (input.count > 0 ? total / input.count : 0)
      : (input.count > 1 ? total / (input.count - 1) : 0)

  return { placements, dropped, spacing, pathLength: total, closed }
}
