// PURE -- no React, no Three, no doc mutation. Connectivity reconstruction for
// offsetting a *connected* profile. Offsetting each entity independently leaves
// the corners disjointed; this module finds the joints of the selection (an
// explicit `coincident`, or endpoints the area builder welds by coordinate) and
// tells the caller how to reconnect the clones (miter the meeting point of two
// offset curves, declare a genuinely tangent joint with a coincident + tangent).
// Whether a joint is tangent is decided from the SOURCE tangents, never from the
// kind alone: a sharp arc corner joined with a `tangent` drags the source
// geometry.
// Node-unit-testable.

import { resolveVertexRef } from '@/types/vertexRef'
import { TOL_MOVE_FACE_TANGENT, TOL_TOPOLOGY_MERGE } from '@/kernel/solverConstants'
import { ANCHORED_KINDS } from '@/kernel/profileLoops'
import { round } from '@/utils/yamlMutations/helpers'

export interface VertexRef {
  entityId: string
  vertexKey: string
}

export interface OffsetCorner {
  a: VertexRef
  b: VertexRef
}

/** Parse a constraint ref against a known entity-id set. Accepts the live local
 *  `$<entityId><vertexKey>` wire form and the already-resolved `{entity, point}`
 *  dict form. Thin wrapper over the shared vertex-ref reader (types/vertexRef):
 *  it keeps the canonical full-id-first + longest-eid tie-break, and this
 *  wrapper requires a vertex key because an offset corner is a sub-point, not a
 *  whole curve. Returns null when the ref is not a vertex of a known entity. */
export function parseVertexRef(ref: unknown, knownIds: ReadonlySet<string>): VertexRef | null {
  const resolved = resolveVertexRef(knownIds, ref)
  return resolved && resolved.point ? { entityId: resolved.entity, vertexKey: resolved.point } : null
}

/** Discover the corners of a selection: `coincident` constraints whose two refs
 *  are vertices of two DISTINCT selected entities. These are the joints that an
 *  offset must rebuild on the clones; non-connectivity constraints are ignored. */
export function offsetCorners(
  selectedIds: string[],
  constraints: Array<{ kind?: string; a?: unknown; b?: unknown }>,
): OffsetCorner[] {
  const known = new Set(selectedIds)
  const corners: OffsetCorner[] = []
  for (const c of constraints) {
    if (c.kind !== 'coincident') continue
    const a = parseVertexRef(c.a, known)
    const b = parseVertexRef(c.b, known)
    if (!a || !b) continue
    if (a.entityId === b.entityId) continue  // a vertex coincident within one entity is not a corner
    corners.push({ a, b })
  }
  return corners
}

/** The endpoint vertices of one entity as `[x, y]` in its flat param array.
 *  A circle is closed and an ellipse's vertex keys are axis ends rather than
 *  curve ends, so neither contributes an endpoint. Arc ends are derived from
 *  centre, radius and the degree angle pair, exactly as the draw/solve side
 *  reads them. */
export function endpointVertices(
  kind: string,
  params: readonly number[],
): Array<{ vertexKey: string; point: [number, number] }> {
  switch (kind) {
    case 'line':
      return [
        { vertexKey: 'start', point: [params[0], params[1]] },
        { vertexKey: 'end', point: [params[2], params[3]] },
      ]
    case 'spline':
      return [
        { vertexKey: 'start', point: [params[0], params[1]] },
        { vertexKey: 'end', point: [params[6], params[7]] },
      ]
    case 'fit_spline':
      // Offset sugar copies a fit spline at source (a true offset is a backlog
      // item), so the corner detector never needs its endpoints.
      return []
    case 'arc': {
      const [cx, cy, r, a0, a1] = params
      const start = (a0 * Math.PI) / 180
      const end = (a1 * Math.PI) / 180
      return [
        { vertexKey: 'start', point: [cx + r * Math.cos(start), cy + r * Math.sin(start)] },
        { vertexKey: 'end', point: [cx + r * Math.cos(end), cy + r * Math.sin(end)] },
      ]
    }
    default:
      return []
  }
}

/** Discover coordinate-joined corners among a selection: endpoint vertices of
 *  two DISTINCT selected entities that sit within the area builder's merge
 *  tolerance. Hand-drawn and imported chains have no coincident constraints, but
 *  the profile builder still welds their shared endpoints, so an offset must
 *  rebuild those joints on the clones too or the offset chain stays open. */
export function coordinateCorners(
  entities: ReadonlyArray<{ id: string; kind: string }>,
  initial: Readonly<Record<string, readonly number[]>>,
  selectedIds: readonly string[],
  tol = TOL_TOPOLOGY_MERGE,
): OffsetCorner[] {
  const selected = new Set(selectedIds)
  const vertices: Array<{ entityId: string; vertexKey: string; point: [number, number] }> = []
  for (const entity of entities) {
    if (!selected.has(entity.id)) continue
    const params = initial[entity.id]
    if (!params) continue
    for (const vertex of endpointVertices(entity.kind, params)) {
      // A NaN coordinate would compare as "within tolerance" (NaN > tol is
      // false) and seed a NaN miter into the clones, so skip it outright.
      if (!Number.isFinite(vertex.point[0]) || !Number.isFinite(vertex.point[1])) continue
      vertices.push({ entityId: entity.id, ...vertex })
    }
  }

  const corners: OffsetCorner[] = []
  for (let i = 0; i < vertices.length; i++) {
    for (let j = i + 1; j < vertices.length; j++) {
      const a = vertices[i], b = vertices[j]
      if (a.entityId === b.entityId) continue
      if (Math.hypot(a.point[0] - b.point[0], a.point[1] - b.point[1]) > tol) continue
      corners.push({
        a: { entityId: a.entityId, vertexKey: a.vertexKey },
        b: { entityId: b.entityId, vertexKey: b.vertexKey },
      })
    }
  }
  return corners
}

/** Drop corners that name the same vertex pair twice. A rectangle carries both
 *  `coincident` constraints and coordinate-equal endpoints, so the two discovery
 *  routes find the same four joints; without this the offset would author two
 *  coincidents per clone corner. */
export function uniqueCorners(corners: readonly OffsetCorner[]): OffsetCorner[] {
  const seen = new Set<string>()
  const unique: OffsetCorner[] = []
  for (const corner of corners) {
    const [a, b] = [
      `${corner.a.entityId}:${corner.a.vertexKey}`,
      `${corner.b.entityId}:${corner.b.vertexKey}`,
    ].sort()
    const key = `${a}|${b}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(corner)
  }
  return unique
}

/** Intersect two infinite lines, each given as `[x0, y0, x1, y1]`. Returns the
 *  intersection point, or null when the lines are near-parallel (the offset
 *  miter degenerates to a gap). The guard is on the angle (normalized cross),
 *  not the raw cross product, so it is independent of the lines' length. */
export function lineIntersect(a: number[], b: number[], angleEps = 1e-6): [number, number] | null {
  const ux = a[2] - a[0], uy = a[3] - a[1]
  const vx = b[2] - b[0], vy = b[3] - b[1]
  const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy)
  if (lu < 1e-9 || lv < 1e-9) return null
  const denom = ux * vy - uy * vx
  if (Math.abs(denom) / (lu * lv) < angleEps) return null  // near-parallel: no miter
  const wx = b[0] - a[0], wy = b[1] - a[1]
  const t = (wx * vy - wy * vx) / denom
  return [a[0] + t * ux, a[1] + t * uy]
}

/** The `[xIndex, yIndex]` of a line vertex within its `[x0, y0, x1, y1]` params,
 *  or null for a key that is not a line endpoint. */
export function lineVertexIndices(vertexKey: string): [number, number] | null {
  if (vertexKey === 'start') return [0, 1]
  if (vertexKey === 'end') return [2, 3]
  return null
}

/** The `[x, y]` of one named entity vertex, or null when the kind has no such
 *  endpoint. Used to pick the offset-curve root nearest the authored joint. */
export function vertexPoint(
  kind: string,
  params: readonly number[],
  vertexKey: string,
): [number, number] | null {
  return endpointVertices(kind, params).find(v => v.vertexKey === vertexKey)?.point ?? null
}

/** Unit tangent LINE direction of an entity at one of its endpoint vertices.
 *  A line's tangent is its own direction; an arc's stored sweep is CCW, so its
 *  tangent at angle theta is `(-sin theta, cos theta)` (the sign of travel does
 *  not matter to the tangent test, which compares lines modulo pi). Returns null
 *  for a kind without an analytic endpoint tangent (circle, spline, ellipse). */
export function endpointTangent(
  kind: string,
  params: readonly number[],
  vertexKey: string,
): [number, number] | null {
  if (vertexKey !== 'start' && vertexKey !== 'end') return null
  if (kind === 'line') {
    const dx = params[2] - params[0], dy = params[3] - params[1]
    const len = Math.hypot(dx, dy)
    if (len < 1e-9) return null
    return [dx / len, dy / len]
  }
  if (kind === 'arc') {
    const deg = vertexKey === 'start' ? params[3] : params[4]
    if (!Number.isFinite(deg)) return null
    const theta = (deg * Math.PI) / 180
    return [-Math.sin(theta), Math.cos(theta)]
  }
  return null
}

export interface TangentSource {
  kind: string
  params: readonly number[]
  vertexKey: string
}

/** Whether two source entities meet tangentially at a corner. The unit tangents
 *  are compared as LINES: `|cross(uA, uB)|` is the sine of the angle between
 *  them, so a line tangent to an arc or two arcs touching are tangent whichever
 *  way each operand travels. `TOL_MOVE_FACE_TANGENT` is the same G1 notion the
 *  3D tangent chain uses. A kind without an endpoint tangent never classifies as
 *  tangent, which keeps spline/ellipse corners ungrafted. */
export function tangentCorner(
  a: TangentSource,
  b: TangentSource,
  tol = TOL_MOVE_FACE_TANGENT,
): boolean {
  const ua = endpointTangent(a.kind, a.params, a.vertexKey)
  const ub = endpointTangent(b.kind, b.params, b.vertexKey)
  if (!ua || !ub) return false
  return Math.abs(ua[0] * ub[1] - ua[1] * ub[0]) <= tol
}

/** One clone endpoint of an offset joint, named so the snap can decide which
 *  side is free to move. */
export interface CloneVertexRef {
  cloneId: string
  kind: string
  vertexKey: string
}

/** Move the free endpoint of a tangent offset joint onto the anchored one, the
 *  same rule the profile handoff welds a merged joint by (`snapLoopJoints` in
 *  `kernel/occ/prismProfile.ts`): an arc endpoint is pinned to its own seeded
 *  curve and wins, a line endpoint is free and moves onto it. Two anchored ends
 *  (arc/arc) have nothing free to move, so their seeds keep their own
 *  positions.
 *
 *  In exact arithmetic both seeds already sit on the same offset joint, but
 *  each stored number is rounded to the document grid on its own, which leaves
 *  up to a grid step between the two. Writing the line onto the arc removes
 *  that gap, so the coincident the caller authors next starts at the seed
 *  instead of asking the solver to close it. Returns whether a vertex moved. */
export function snapTangentJoint(
  initial: Readonly<Record<string, number[]>>,
  a: CloneVertexRef,
  b: CloneVertexRef,
): boolean {
  const anchoredA = ANCHORED_KINDS.has(a.kind)
  const anchoredB = ANCHORED_KINDS.has(b.kind)
  if (anchoredA && anchoredB) return false
  const [keeper, moved] = anchoredB ? [b, a] : [a, b]
  // The anchored side is an arc, so the free side is a line: only it has
  // coordinates that can take the joint value as written.
  if (moved.kind !== 'line') return false
  const keeperParams = initial[keeper.cloneId]
  const movedParams = initial[moved.cloneId]
  if (!keeperParams || !movedParams) return false
  const point = vertexPoint(keeper.kind, keeperParams, keeper.vertexKey)
  const indices = lineVertexIndices(moved.vertexKey)
  if (!point || !indices) return false
  movedParams[indices[0]] = round(point[0])
  movedParams[indices[1]] = round(point[1])
  return true
}

/** Intersections of the infinite line through `[x0, y0, x1, y1]` with a circle.
 *  Empty when the line misses the circle; one point when it is tangent. */
export function lineCircleIntersect(
  line: readonly number[],
  cx: number,
  cy: number,
  r: number,
): Array<[number, number]> {
  const dx = line[2] - line[0], dy = line[3] - line[1]
  const len = Math.hypot(dx, dy)
  if (len < 1e-9 || !(r > 0)) return []
  const ux = dx / len, uy = dy / len
  const fx = line[0] - cx, fy = line[1] - cy
  const b = fx * ux + fy * uy
  const c = fx * fx + fy * fy - r * r
  const disc = b * b - c
  if (disc < 0) return []
  const root = Math.sqrt(Math.max(0, disc))
  const ts = root < 1e-12 ? [-b] : [-b - root, -b + root]
  return ts.map(t => [line[0] + t * ux, line[1] + t * uy])
}

/** Intersections of two circles. Empty when they are concentric, disjoint or
 *  nested without touching; one point when they touch. */
export function circleCircleIntersect(
  ax: number, ay: number, ar: number,
  bx: number, by: number, br: number,
): Array<[number, number]> {
  const dx = bx - ax, dy = by - ay
  const d = Math.hypot(dx, dy)
  if (d < 1e-9 || !(ar > 0) || !(br > 0)) return []
  if (d > ar + br + 1e-9 || d < Math.abs(ar - br) - 1e-9) return []
  const a = (ar * ar - br * br + d * d) / (2 * d)
  const h = Math.sqrt(Math.max(0, ar * ar - a * a))
  const ux = dx / d, uy = dy / d
  const mx = ax + a * ux, my = ay + a * uy
  if (h < 1e-12) return [[mx, my]]
  return [
    [mx - h * uy, my + h * ux],
    [mx + h * uy, my - h * ux],
  ]
}

/** The root closest to a reference point, or null when there is none. At a
 *  sharp joint the near intersection is the miter; the far one belongs to the
 *  other side of the circle. */
export function nearestPoint(
  points: ReadonlyArray<[number, number]>,
  near: readonly [number, number],
): [number, number] | null {
  let best: [number, number] | null = null
  let bestD = Infinity
  for (const p of points) {
    const d = Math.hypot(p[0] - near[0], p[1] - near[1])
    if (d < bestD) {
      bestD = d
      best = p
    }
  }
  return best
}

/** The CCW span from `from` to `to` in degrees, in [0, 360). */
export function ccwSpanDeg(from: number, to: number): number {
  return (((to - from) % 360) + 360) % 360
}

/** A miter may extend an arc past an authored endpoint, but not by more than a
 *  quarter turn: past that the intersection belongs to the far side of the
 *  circle rather than this joint, and writing it would swing the arc around its
 *  other end. */
export const MAX_ARC_MITER_EXTENSION_DEG = 90

/** Whether writing `deg` into an arc's start (index 3) or end (index 4) keeps
 *  the stored CCW sweep on the same side of the other endpoint. A joint whose
 *  miter would cross the other end is left ungrafted rather than silently
 *  reversing or degenerating the arc. */
export function arcAngleKeepsSweep(
  a0: number,
  a1: number,
  deg: number,
  vertexKey: 'start' | 'end',
): boolean {
  if (!Number.isFinite(deg)) return false
  const sweep = ccwSpanDeg(a0, a1)
  if (sweep === 0) return false  // a full-circle arc has no distinct other end
  if (vertexKey === 'start') {
    const newSweep = ccwSpanDeg(deg, a1)
    if (newSweep === 0) return false  // the new start landed on the end: full circle
    const inside = ccwSpanDeg(a0, deg) <= sweep  // moved toward the authored end
    const justBefore = ccwSpanDeg(deg, a0) <= MAX_ARC_MITER_EXTENSION_DEG
    return inside || justBefore
  }
  const newSweep = ccwSpanDeg(a0, deg)
  if (newSweep === 0) return false  // the new end landed on the start: full circle
  const inside = ccwSpanDeg(deg, a1) <= sweep  // moved back toward the authored start
  const justPast = ccwSpanDeg(a1, deg) <= MAX_ARC_MITER_EXTENSION_DEG
  return inside || justPast
}
