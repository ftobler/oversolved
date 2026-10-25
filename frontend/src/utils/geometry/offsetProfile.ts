// PURE -- no React, no Three, no doc mutation. Connectivity reconstruction for
// offsetting a *connected* profile. Offsetting each entity independently leaves
// the corners disjointed; this module finds the joints of the selection (an
// explicit `coincident`, or endpoints the area builder welds by coordinate) and
// tells the caller how to reconnect the clones (miter the meeting point of two
// offset lines, carry tangency over to arcs). Node-unit-testable.

import { resolveVertexRef } from '@/types/vertexRef'
import { TOL_TOPOLOGY_MERGE } from '@/kernel/solverConstants'

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
