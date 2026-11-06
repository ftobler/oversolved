// PURE -- no doc mutation, no Three.js, no React refs. The corner math of the
// sketch fillet: given two straight sides that meet at a corner, the radius,
// and the sketch's profile, produce the two tangent points and the arc that
// joins them. The applier (yamlMutations/sketchFillet.ts) turns this into
// document writes; this file only decides what the rounded corner is.
//
// The material probe shares the even-odd segment soup with the offset side rule
// (geometry/profileProbe.ts), so the two rules cannot disagree about which side
// of a loop is bounded. A side with material on neither side is an open chain
// and rounds as a convex corner; a side with material on both is not a profile
// boundary, and a corner that cannot say which way it faces is refused rather
// than guessed.

import type { PartConstraint } from '@/types/cad'
import { isVertexKeyRef, round } from '@/utils/yamlMutations/helpers'
import { TOL_TOPOLOGY_MERGE } from '@/kernel/solverConstants'
import { inside, probeExtent, segmentsOf, type ProbeSegment } from './profileProbe'

export type FilletVertexKey = 'start' | 'end'
export type FilletSide = 'convex' | 'concave'

// The command surface's partner map: one entry per line endpoint of the active
// sketch, keyed by its `vertex:<sketch>:<entity>:<key>` selection id. A vertex
// with no single line partner carries the refusal reason instead of a partner.
export interface FilletCornerPartner {
  entityId: string
  vertexKey: FilletVertexKey
}
export type FilletCornerCandidate =
  | { partner: FilletCornerPartner; side?: FilletSide }
  | { reason: string }
export type FilletCornerMap = Record<string, FilletCornerCandidate>

export interface FilletCorner {
  a: string
  aVertex: FilletVertexKey
  b: string
  bVertex: FilletVertexKey
  // Skips the material probe when the caller already knows which side the
  // material lies on (an explicit authoring hint).
  side?: FilletSide
}

/** One sketch entity as the corner math reads it: kind, authored block, and the
 *  two flags that decide whether it may be a side at all. */
export interface FilletCornerSide {
  id: string
  kind: string
  params: readonly number[]
  construction?: boolean
  source?: string
}

export interface FilletGeometry {
  a: string
  aVertex: FilletVertexKey
  b: string
  bVertex: FilletVertexKey
  corner: [number, number]
  center: [number, number]
  radius: number
  // The tangent point on each side, in the side's own direction.
  ta: [number, number]
  tb: [number, number]
  tangentDistance: number
  sweepDeg: number
  // `[cx, cy, r, a0_deg, a1_deg]`, the stored arc block. a0 -> a1 is the CCW
  // sweep, and a1 may exceed 360 so the pair reads as one sweep.
  arc: [number, number, number, number, number]
  // Which arc endpoint sits at `ta`; the other is at `tb`.
  arcStart: FilletVertexKey
  arcEnd: FilletVertexKey
  construction: boolean
  side: FilletSide
}

export interface FilletGeometryRefusal {
  reason: string
  // Set when a named side does not exist, so the drive boundary can report an
  // unknown target instead of a value error.
  missingId?: string
  lineId?: string
  maxRadius?: number
}

export type FilletGeometryPlan = { corners: FilletGeometry[] } | FilletGeometryRefusal

type Point = [number, number]

const DEG = 180 / Math.PI

function norm(v: Point): Point | null {
  const len = Math.hypot(v[0], v[1])
  return len > 1e-12 ? [v[0] / len, v[1] / len] : null
}

function sub(a: Point, b: Point): Point {
  return [a[0] - b[0], a[1] - b[1]]
}

function add(a: Point, b: Point): Point {
  return [a[0] + b[0], a[1] + b[1]]
}

function mul(v: Point, s: number): Point {
  return [v[0] * s, v[1] * s]
}

function finiteParams(params: readonly number[], count: number): boolean {
  if (params.length < count) return false
  for (let i = 0; i < count; i++) {
    if (!Number.isFinite(params[i])) return false
  }
  return true
}

function endpoint(params: readonly number[], key: FilletVertexKey): Point {
  return key === 'start' ? [params[0], params[1]] : [params[2], params[3]]
}

function otherEndpointKey(key: FilletVertexKey): FilletVertexKey {
  return key === 'start' ? 'end' : 'start'
}

function lineLength(params: readonly number[]): number {
  return Math.hypot(params[2] - params[0], params[3] - params[1])
}

/** Intersection of the two infinite lines, or null when they are parallel. */
function lineIntersection(a: readonly number[], b: readonly number[]): Point | null {
  const ux = a[2] - a[0], uy = a[3] - a[1]
  const vx = b[2] - b[0], vy = b[3] - b[1]
  const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy)
  if (lu < 1e-9 || lv < 1e-9) return null
  const denom = ux * vy - uy * vx
  if (Math.abs(denom) <= 1e-12 * lu * lv) return null
  const t = ((b[0] - a[0]) * vy - (b[1] - a[1]) * vx) / denom
  return [a[0] + t * ux, a[1] + t * uy]
}

/** The unit normal of a line on the filled side, null for an open chain, or
 *  'ambiguous' when both sides probe as filled (the line is not a boundary). */
function materialNormal(
  params: readonly number[],
  segments: readonly ProbeSegment[],
  eps: number,
): Point | null | 'ambiguous' {
  const dx = params[2] - params[0], dy = params[3] - params[1]
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) return null
  const mid: Point = [(params[0] + params[2]) / 2, (params[1] + params[3]) / 2]
  const left: Point = [-dy / len, dx / len]
  const leftFilled = inside(add(mid, mul(left, eps)), segments)
  const rightFilled = inside(add(mid, mul(left, -eps)), segments)
  if (leftFilled && rightFilled) return 'ambiguous'
  if (leftFilled) return left
  if (rightFilled) return [-left[0], -left[1]]
  return null
}

const vertexLabel = (corner: FilletCorner): string =>
  `${corner.a}:${corner.aVertex} and ${corner.b}:${corner.bVertex}`

/**
 * Plan every requested corner before anything is written. Any refusal returns
 * the whole plan refused: the applier never trims one side of a step whose
 * later corner is invalid.
 */
export function planFilletGeometry(
  entities: readonly FilletCornerSide[],
  corners: readonly FilletCorner[],
  radius: number,
): FilletGeometryPlan {
  if (!Number.isFinite(radius) || radius <= 0) {
    return { reason: `radius must be a finite number greater than zero, got ${radius}` }
  }
  if (corners.length === 0) return { reason: 'corners must name at least one corner' }

  const byId = new Map(entities.map(entity => [entity.id, entity]))

  // The probe soup is every non-construction profile entity, not just the two
  // sides: a hole loop and an outer loop both have to classify correctly.
  const segments: ProbeSegment[] = []
  for (const entity of entities) {
    if (entity.construction) continue
    const sampled = segmentsOf(entity)
    if (sampled === null) {
      return {
        reason: `material side is unknown: entity "${entity.id}" (${entity.kind}) cannot be sampled`,
        missingId: entity.id,
      }
    }
    segments.push(...sampled)
  }
  const eps = 1e-6 * probeExtent(segments)

  const seen = new Set<string>()
  const planned: Array<{
    geometry: FilletGeometry
    halfCotangentA: number
    halfCotangentB: number
  }> = []

  for (let index = 0; index < corners.length; index++) {
    const request = corners[index]
    const where = `corner ${index}`
    if (request.a === request.b) {
      return { reason: `${where}: a corner needs two different lines, got "${request.a}" twice` }
    }
    const sideA = byId.get(request.a)
    const sideB = byId.get(request.b)
    for (const [id, side] of [[request.a, sideA], [request.b, sideB]] as const) {
      if (side === undefined) {
        return { reason: `${where}: side "${id}" names no entity in the sketch`, missingId: id }
      }
      if (side.source !== undefined) {
        return { reason: `${where}: side "${id}" is projected geometry and is not a hand-authored profile side` }
      }
      if (side.kind !== 'line') {
        const already = side.kind === 'arc' || side.kind === 'circle'
          ? `; the corner already meets an arc (${id}), so it is already rounded`
          : `; a fillet needs two straight line sides, not a ${side.kind} (${id})`
        return { reason: `${where}: side "${id}" is a ${side.kind}${already}` }
      }
      if (!finiteParams(side.params, 4) || lineLength(side.params) < 1e-9) {
        return { reason: `${where}: side "${id}" is degenerate or has a non-finite block` }
      }
    }
    const a = sideA!
    const b = sideB!

    const pairKey = [
      `${request.a}:${request.aVertex}`,
      `${request.b}:${request.bVertex}`,
    ].sort().join('|')
    if (seen.has(pairKey)) {
      return { reason: `${where}: duplicates an earlier corner (${vertexLabel(request)})` }
    }
    seen.add(pairKey)

    const namedA = endpoint(a.params, request.aVertex)
    const namedB = endpoint(b.params, request.bVertex)
    if (Math.hypot(namedA[0] - namedB[0], namedA[1] - namedB[1]) > TOL_TOPOLOGY_MERGE) {
      return {
        reason: `${where}: the endpoints of "${request.a}" and "${request.b}" do not meet at this corner `
          + `(distance ${round(Math.hypot(namedA[0] - namedB[0], namedA[1] - namedB[1]))} > ${TOL_TOPOLOGY_MERGE})`,
      }
    }

    const cornerPoint = lineIntersection(a.params, b.params)
    if (cornerPoint === null) {
      return { reason: `${where}: sides "${request.a}" and "${request.b}" are parallel; there is no corner` }
    }

    const otherA = endpoint(a.params, otherEndpointKey(request.aVertex))
    const otherB = endpoint(b.params, otherEndpointKey(request.bVertex))
    const uA = norm(sub(otherA, cornerPoint))
    const uB = norm(sub(otherB, cornerPoint))
    if (uA === null || uB === null) {
      return { reason: `${where}: sides "${request.a}" and "${request.b}" are degenerate at the corner` }
    }

    const cosTheta = Math.max(-1, Math.min(1, uA[0] * uB[0] + uA[1] * uB[1]))
    const theta = Math.acos(cosTheta)
    if (theta < 1e-6) {
      return { reason: `${where}: sides "${request.a}" and "${request.b}" are collinear; there is no corner` }
    }
    if (Math.PI - theta < 1e-6) {
      return { reason: `${where}: sides "${request.a}" and "${request.b}" are already tangent; there is no corner` }
    }

    if ((a.construction === true) !== (b.construction === true)) {
      return {
        reason: `${where}: a mixed construction corner is refused; "${request.a}" and "${request.b}" `
          + 'must both be construction or both be profile geometry',
      }
    }

    const tanHalf = Math.tan(theta / 2)
    const sinHalf = Math.sin(theta / 2)
    const tangentDistance = radius / tanHalf
    if (tangentDistance >= lineLength(a.params) || tangentDistance >= lineLength(b.params)) {
      const shorter = lineLength(a.params) <= lineLength(b.params) ? a : b
      const maxRadius = lineLength(shorter.params) * tanHalf
      return {
        reason: `${where}: radius ${round(radius)} is too large for line "${shorter.id}"; `
          + `the greatest radius is ${round(maxRadius)}`,
        lineId: shorter.id,
        maxRadius: round(maxRadius),
      }
    }

    let side: FilletSide = request.side ?? 'convex'
    if (request.side === undefined) {
      const nA = materialNormal(a.params, segments, eps)
      const nB = materialNormal(b.params, segments, eps)
      if (nA === 'ambiguous' || nB === 'ambiguous') {
        const bad = nA === 'ambiguous' ? a : b
        return { reason: `${where}: line "${bad.id}" has material on both sides, so its material side is ambiguous` }
      }
      if (nA !== null && nB !== null) {
        const dot = nA[0] * nB[0] + nA[1] * nB[1]
        if (dot <= -1 + 1e-9) {
          return { reason: `${where}: sides "${request.a}" and "${request.b}" are straight; there is no corner` }
        }
        const mixed = norm(sub(nA, nB))
        if (mixed !== null) {
          const p1 = add(cornerPoint, mul(mixed, eps))
          const p2 = add(cornerPoint, mul(mixed, -eps))
          if (inside(p1, segments) || inside(p2, segments)) side = 'concave'
        }
      }
    }

    const ta = add(cornerPoint, mul(uA, tangentDistance))
    const tb = add(cornerPoint, mul(uB, tangentDistance))

    // The centre always lies in the wedge between the two rays; a convex corner
    // puts material there, a concave corner puts the void there. The material
    // probe above still had to run: it is what decides which of the two the
    // corner is, and what refuses a line that is not a boundary at all.
    const bisector = norm(add(uA, uB))
    if (bisector === null) {
      return { reason: `${where}: the corner has no bisector; the sides are straight` }
    }
    const centerDistance = radius / sinHalf
    const center = add(cornerPoint, mul(bisector, centerDistance))

    const angleTA = Math.atan2(ta[1] - center[1], ta[0] - center[0]) * DEG
    const angleTB = Math.atan2(tb[1] - center[1], tb[0] - center[0]) * DEG
    const aTA = ((angleTA % 360) + 360) % 360
    const aTB = ((angleTB % 360) + 360) % 360
    const spanAB = ((aTB - aTA) + 360) % 360
    const sweepDeg = 180 - theta * DEG
    let startIsTA: boolean
    if (Math.abs(spanAB - sweepDeg) <= 1e-6) startIsTA = true
    else if (Math.abs((360 - spanAB) - sweepDeg) <= 1e-6) startIsTA = false
    else {
      return { reason: `${where}: the tangent points do not admit the expected ${round(sweepDeg)} degree sweep` }
    }
    const startAngle = startIsTA ? aTA : aTB
    const a0 = ((startAngle % 360) + 360) % 360
    const a1 = a0 + sweepDeg
    const construction = a.construction === true && b.construction === true

    planned.push({
      geometry: {
        a: request.a,
        aVertex: request.aVertex,
        b: request.b,
        bVertex: request.bVertex,
        corner: [round(cornerPoint[0]), round(cornerPoint[1])],
        center: [round(center[0]), round(center[1])],
        radius: round(radius),
        ta: [round(ta[0]), round(ta[1])],
        tb: [round(tb[0]), round(tb[1])],
        tangentDistance: round(tangentDistance),
        sweepDeg: round(sweepDeg),
        arc: [round(center[0]), round(center[1]), round(radius), round(a0), round(a1)],
        arcStart: startIsTA ? 'start' : 'end',
        arcEnd: startIsTA ? 'end' : 'start',
        construction,
        side,
      },
      halfCotangentA: 1 / tanHalf,
      halfCotangentB: 1 / tanHalf,
    })
  }

  // Two corners may trim the two ends of one line. Each trim was checked alone
  // above; the pair must still leave a segment, or the line would reverse or
  // vanish. The greatest common radius is the length divided by the summed
  // cotangents, and the refusal names the line and that radius.
  const perLine = new Map<string, { sumCotangent: number; index: number }>()
  planned.forEach((entry, index) => {
    for (const [id, cot] of [
      [entry.geometry.a, entry.halfCotangentA],
      [entry.geometry.b, entry.halfCotangentB],
    ] as const) {
      const record = perLine.get(id) ?? { sumCotangent: 0, index }
      record.sumCotangent += cot
      record.index = index
      perLine.set(id, record)
    }
  })
  for (const [id, record] of perLine) {
    const side = byId.get(id)
    if (side === undefined) continue
    const length = lineLength(side.params)
    if (radius * record.sumCotangent >= length) {
      const maxRadius = length / record.sumCotangent
      return {
        reason: `corner ${record.index}: radius ${round(radius)} is too large for line "${id}"; `
          + `the two fillets on it would leave no segment, and the greatest radius is ${round(maxRadius)}`,
        lineId: id,
        maxRadius: round(maxRadius),
      }
    }
  }

  return { corners: planned.map(entry => entry.geometry) }
}

interface EndpointRef {
  entityId: string
  vertexKey: FilletVertexKey
}

const endpointStorageKey = (ref: EndpointRef): string => `${ref.entityId}:${ref.vertexKey}`

/**
 * The corner partner map Geometry3D publishes for the command gate. A partner
 * is another line's endpoint joined to this one by a coincident constraint or
 * by coordinate equality (the profile builder welds both), so a hand-drawn
 * corner with no constraint still rounds. Exactly one partner is required:
 * none is "no line partner", two or more is a T-junction or duplicate joint.
 */
export function buildFilletCornerMap(
  featureId: string,
  entities: readonly FilletCornerSide[],
  constraints: readonly PartConstraint[],
): FilletCornerMap {
  const lines = entities.filter(entity =>
    entity.kind === 'line' && finiteParams(entity.params, 4) && lineLength(entity.params) >= 1e-9)
  const endpoints = new Map<string, EndpointRef & { point: Point }>()
  for (const line of lines) {
    for (const key of ['start', 'end'] as const) {
      const point = endpoint(line.params, key)
      endpoints.set(endpointStorageKey({ entityId: line.id, vertexKey: key }), {
        entityId: line.id,
        vertexKey: key,
        point,
      })
    }
  }

  // A stored constraint operand names its endpoint through the shared vertex
  // ref predicate, never a hand-built `$` string (the doc-ref ratchet).
  const wireEndpoint = (ref: string): EndpointRef | undefined =>
    [...endpoints.values()].find(end => isVertexKeyRef(ref, end.entityId, end.vertexKey))

  const partners = new Map<string, Set<string>>()
  const link = (a: EndpointRef, b: EndpointRef): void => {
    if (a.entityId === b.entityId) return
    const key = endpointStorageKey(a)
    const set = partners.get(key) ?? new Set<string>()
    set.add(endpointStorageKey(b))
    partners.set(key, set)
  }

  for (const c of constraints) {
    if (c.kind !== 'coincident' || typeof c.a !== 'string' || typeof c.b !== 'string') continue
    const a = wireEndpoint(c.a)
    const b = wireEndpoint(c.b)
    if (a === undefined || b === undefined) continue
    link(a, b)
    link(b, a)
  }

  // Coordinate-welded corners: the same tolerance the profile builder uses.
  const all = [...endpoints.values()]
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j]
      if (a.entityId === b.entityId) continue
      if (Math.hypot(a.point[0] - b.point[0], a.point[1] - b.point[1]) > TOL_TOPOLOGY_MERGE) continue
      link(a, b)
      link(b, a)
    }
  }

  const map: FilletCornerMap = {}
  for (const ref of endpoints.values()) {
    const key = `vertex:${featureId}:${ref.entityId}:${ref.vertexKey}`
    const linked = partners.get(endpointStorageKey(ref))
    if (linked === undefined || linked.size === 0) {
      map[key] = { reason: `vertex "${ref.entityId}:${ref.vertexKey}" has no line partner in this sketch` }
    } else if (linked.size > 1) {
      map[key] = {
        reason: `vertex "${ref.entityId}:${ref.vertexKey}" has more than one line partner `
          + '(a T-junction or duplicate joint)',
      }
    } else {
      const [only] = [...linked]
      const [entityId, vertexKey] = only.split(':') as [string, FilletVertexKey]
      map[key] = { partner: { entityId, vertexKey } }
    }
  }
  return map
}
