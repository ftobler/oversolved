// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
// See docs/viewport.md "Layer Contracts" and feature/feature_headless_viewport.md.
//
// Mirror math for sketch entities: reflect one entity's flat parameter block in an
// arbitrary line of the sketch plane, and map one of its vertex keys onto the
// mirrored entity. Math only; minting ids and rewriting constraints is the applier's
// job (yamlMutations/sketchMirror.ts).

import type { EntityKind } from '@/types/cad'
import { round, allFinite } from '@/utils/yamlMutations/helpers'
import { ellipseAxisPoints } from './ellipseAxis'
import { fitSplineVertices } from '@/registry/entityRegistry'

/**
 * The mirror axis as a line segment (any two points on it; the line is infinite).
 * Same slot order as a line entity's flat params.
 */
export interface MirrorAxis {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** The axis a `line` entity's flat params [x1, y1, x2, y2] carry, or null when the
 *  block is not one: non-finite slots or a degenerate segment (a point has no line
 *  to reflect in). This is the axis-level half of the allFinite gate. */
export function mirrorAxisFromLineParams(params: readonly number[]): MirrorAxis | null {
  if (params.length !== 4 || !allFinite(params)) return null
  const [x1, y1, x2, y2] = params
  const dx = x2 - x1
  const dy = y2 - y1
  // A near-degenerate axis would produce a reflection about an arbitrary direction
  // chosen by atan2 noise; refuse it like an exact one.
  if (dx * dx + dy * dy <= 1e-18) return null
  return { x1, y1, x2, y2 }
}

const DEG = Math.PI / 180

/** The axis as a direction vector plus its squared length, or null for a
 *  degenerate (zero-length) axis: a point has no line to reflect in, and
 *  dividing by len2 == 0 would poison every coordinate with NaN. */
function axisVector(axis: MirrorAxis): { ux: number; uy: number; len2: number } | null {
  if (!allFinite([axis.x1, axis.y1, axis.x2, axis.y2])) return null
  const ux = axis.x2 - axis.x1
  const uy = axis.y2 - axis.y1
  const len2 = ux * ux + uy * uy
  return len2 > 1e-18 ? { ux, uy, len2 } : null
}

/** The axis direction angle in degrees (atan2 branch, (-180, 180]). The axis line
 *  is undirected: alpha and alpha+180 reflect the same set of points, and every
 *  consumer here is 180-periodic in it. */
export function mirrorAxisAngleDeg(axis: MirrorAxis): number {
  return Math.atan2(axis.y2 - axis.y1, axis.x2 - axis.x1) / DEG
}

/** Reflect one point in the axis line: P' = 2 * foot(P) - P, with the foot the
 *  projection of P onto the infinite line through (x1, y1) with unit direction u.
 *  Callers hold a non-degenerate axis (the mutation applier refuses the axis at
 *  `mirrorAxisFromLineParams`). */
export function mirrorPoint(p: readonly [number, number], axis: MirrorAxis): [number, number] {
  const av = axisVector(axis)!
  const px = p[0] - axis.x1
  const py = p[1] - axis.y1
  const t = (px * av.ux + py * av.uy) / av.len2
  return [axis.x1 + 2 * t * av.ux - px, axis.y1 + 2 * t * av.uy - py]
}

/** Reflect an offset vector (no anchor point): the linear part of the reflection,
 *  v' = 2u(v.u) - v. Used for constraint label offsets, which are positions
 *  relative to their anchor. */
export function mirrorVector(v: readonly [number, number], axis: MirrorAxis): [number, number] {
  const av = axisVector(axis)!
  const t = (v[0] * av.ux + v[1] * av.uy) / av.len2
  return [2 * t * av.ux - v[0], 2 * t * av.uy - v[1]]
}

/** Reflect an arc angle in the axis: angle -> 2*alpha - angle. */
export function mirrorAngleDeg(angleDeg: number, axisAngleDeg: number): number {
  return 2 * axisAngleDeg - angleDeg
}

const normDeg = (d: number): number => ((d % 360) + 360) % 360

/**
 * Mirror an arc's authored (a0_deg, a1_deg) pair across the axis at angle alpha.
 *
 * An arc is authored as the CCW sweep from a0 to a1 (entityRegistry). Reflection
 * reverses sweep direction, so the image arc runs from the image of the old END
 * back CCW to the image of the old START: new a0 is the mirrored a1, and the span
 * is the original wrapped CCW span. Reflecting the two angles in place instead
 * would name the complementary arc (the wrong geometry).
 *
 * a0 is normalized into [0, 360); a1 = a0 + span may exceed 360, which keeps the
 * stored pair CCW-readable (a1 - a0 is exactly the sweep). A full-circle arc
 * (a1 - a0 = 360) keeps its 360 span instead of collapsing to a zero arc.
 */
export function mirrorArcAngles(
  a0: number,
  a1: number,
  axisAngleDeg: number,
): [number, number] {
  const raw = a1 - a0
  let span = normDeg(raw)
  if (span === 0 && raw !== 0) span = 360  // a full-circle arc stays closed
  const start = normDeg(mirrorAngleDeg(a1, axisAngleDeg))
  return [start, start + span]
}

/** Fit-spline blocks are `2 N + 2 h` scalars (N fit points, h end handles); null
 *  when the authored `handles` flag and the block length disagree. */
function fitSplineHandleCount(handles?: 'start' | 'end' | 'both'): number {
  return handles === 'both' ? 2 : handles === 'start' || handles === 'end' ? 1 : 0
}

function fitSplineFitPoints(params: readonly number[], handles?: 'start' | 'end' | 'both'): number | null {
  if (params.length % 2 !== 0) return null
  const n = params.length / 2 - fitSplineHandleCount(handles)
  return n >= 2 ? n : null
}

/**
 * The mirrored flat params of one entity, or null when the kind or the block is
 * not mirrorable (unknown kind, wrong block length, non-finite input -- the
 * allFinite gate for entity data). Every coordinate pair the block carries is
 * reflected; scalars that name size (radius, semi-axes, spans) are invariant or
 * derived. Arcs and ellipses get the handedness/rotation treatment documented on
 * `mirrorArcAngles`; an ellipse keeps `theta_deg` unnormalized so its derived
 * axis endpoints stay on the mirrored side they came from.
 */
export function mirrorEntityParams(
  kind: EntityKind | string,
  params: readonly number[],
  axis: MirrorAxis,
  handles?: 'start' | 'end' | 'both',
): number[] | null {
  if (axisVector(axis) === null || !allFinite(params)) return null
  const alpha = mirrorAxisAngleDeg(axis)
  const pair = (i: number): [number, number] => [params[i], params[i + 1]]

  switch (kind) {
    case 'line': {
      if (params.length !== 4) return null
      const a = mirrorPoint(pair(0), axis)
      const b = mirrorPoint(pair(2), axis)
      return [a[0], a[1], b[0], b[1]].map(round)
    }
    case 'point': {
      if (params.length !== 2) return null
      const p = mirrorPoint(pair(0), axis)
      return [p[0], p[1]].map(round)
    }
    case 'circle': {
      if (params.length !== 3) return null
      const c = mirrorPoint(pair(0), axis)
      return [c[0], c[1], params[2]].map(round)  // radius is mirror-invariant
    }
    case 'arc': {
      if (params.length !== 5) return null
      const c = mirrorPoint(pair(0), axis)
      const [a0, a1] = mirrorArcAngles(params[3], params[4], alpha)
      return [c[0], c[1], params[2], a0, a1].map(round)
    }
    case 'ellipse': {
      if (params.length !== 5) return null
      const c = mirrorPoint(pair(0), axis)
      return [c[0], c[1], params[2], params[3], mirrorAngleDeg(params[4], alpha)].map(round)
    }
    case 'spline': {
      // A cubic Bezier: four control points [x1, y1, c1x, c1y, c2x, c2y, x2, y2].
      // Reflecting every control point reflects the curve; the start/c1/c2/end key
      // slots keep their order, so constraint refs and handles remap by identity.
      if (params.length !== 8) return null
      const out: number[] = []
      for (let i = 0; i < 8; i += 2) out.push(...mirrorPoint(pair(i), axis))
      return out.map(round)
    }
    case 'fit_spline': {
      if (fitSplineFitPoints(params, handles) === null) return null
      const out: number[] = []
      for (let i = 0; i < params.length; i += 2) out.push(...mirrorPoint(pair(i), axis))
      return out.map(round)
    }
    default:
      return null
  }
}

/**
 * The canonical vertex positions of one entity instance: the registry's named
 * vertices plus the derived ones a ref may name -- arc `start`/`end` (the angle
 * endpoints) and the ellipse axis endpoints (major1/major2/minor1/minor2). Null
 * for a malformed block or unknown kind.
 */
export function canonicalVertexPositions(
  kind: EntityKind | string,
  params: readonly number[],
  handles?: 'start' | 'end' | 'both',
): Record<string, [number, number]> | null {
  switch (kind) {
    case 'line': {
      if (params.length !== 4) return null
      return { start: [params[0], params[1]], end: [params[2], params[3]] }
    }
    case 'point': {
      if (params.length !== 2) return null
      return { xy: [params[0], params[1]] }
    }
    case 'circle': {
      if (params.length !== 3) return null
      return { center: [params[0], params[1]] }
    }
    case 'arc': {
      if (params.length !== 5) return null
      const [cx, cy, r, a0, a1] = params
      return {
        center: [cx, cy],
        start: [cx + r * Math.cos(a0 * DEG), cy + r * Math.sin(a0 * DEG)],
        end: [cx + r * Math.cos(a1 * DEG), cy + r * Math.sin(a1 * DEG)],
      }
    }
    case 'ellipse': {
      if (params.length !== 5) return null
      const [cx, cy, a, b, theta] = params
      return { center: [cx, cy], ...ellipseAxisPoints(cx, cy, a, b, theta) }
    }
    case 'spline': {
      if (params.length !== 8) return null
      return {
        start: [params[0], params[1]],
        c1: [params[2], params[3]],
        c2: [params[4], params[5]],
        end: [params[6], params[7]],
      }
    }
    case 'fit_spline': {
      const n = fitSplineFitPoints(params, handles)
      if (n === null) return null
      const out: Record<string, [number, number]> = {}
      for (const v of fitSplineVertices(n, handles).vertices) {
        const [i, j] = v.indices
        out[v.key] = [params[i], params[j]]
      }
      return out
    }
    default:
      return null
  }
}

/** Position tolerance for vertex matching. Params round to 1e-6; derived trig
 *  adds a little more, so a matched key must agree to a hair looser. */
const VERTEX_TOL = 1e-4

const near = (a: readonly [number, number], b: readonly [number, number]): boolean =>
  Math.hypot(a[0] - b[0], a[1] - b[1]) <= VERTEX_TOL * Math.max(1, Math.abs(a[0]), Math.abs(a[1]))

/**
 * Which vertex key of the mirrored entity names the mirror image of `key` on the
 * original entity. Arc `start`/`end` swap as a consequence of `mirrorArcAngles`
 * (the image of the old start is the new end); positional keys (fit points,
 * Bezier controls, ellipse axis ends, centers) resolve by matching the mirrored
 * position against the mirrored entity's canonical vertices. Null when the image
 * matches no canonical vertex: the caller drops the ref rather than mis-anchoring
 * it (a circle quadrant on a 22.5 deg axis has no canonical image).
 */
export function mirrorVertexKey(
  kind: EntityKind | string,
  key: string,
  params: readonly number[],
  axis: MirrorAxis,
  handles?: 'start' | 'end' | 'both',
): string | null {
  const source = canonicalVertexPositions(kind, params, handles)?.[key]
  if (source === undefined) return null
  const mirrored = mirrorEntityParams(kind, params, axis, handles)
  if (mirrored === null) return null
  const targets = canonicalVertexPositions(kind, mirrored, handles)
  if (targets === null) return null
  const wanted = mirrorPoint(source, axis)
  for (const [candidate, pos] of Object.entries(targets)) {
    if (near(pos, wanted)) return candidate
  }
  return null
}
