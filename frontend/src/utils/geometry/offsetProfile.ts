// PURE -- no React, no Three, no doc mutation. Connectivity reconstruction for
// offsetting a *connected* profile. Offsetting each entity independently leaves
// the corners disjointed; this module finds the coincident corners of the
// selection and tells the caller how to reconnect the clones (miter the meeting
// point of two offset lines, carry tangency over to arcs). Node-unit-testable.

import { VERTEX_POINT_KEYS } from '@/types/vertexKeys'

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
 *  dict form (see `partDocToSketches` `resolveLocal`). Returns null when the ref
 *  is not a vertex of a known entity. */
export function parseVertexRef(ref: unknown, knownIds: Set<string>): VertexRef | null {
  if (ref && typeof ref === 'object') {
    const obj = ref as { entity?: unknown; point?: unknown }
    if (typeof obj.entity === 'string' && knownIds.has(obj.entity) && typeof obj.point === 'string') {
      return { entityId: obj.entity, vertexKey: obj.point }
    }
    return null
  }
  if (typeof ref !== 'string' || !ref.startsWith('$')) return null
  const bare = ref.slice(1)
  // The entity id is base64url and can itself end in a vertex-key word, so we
  // disambiguate by requiring the prefix to be a *known* selected entity. If more
  // than one (eid, key) split lands on a known id (possible only with adversarial
  // ids), prefer the longest eid (shortest key) so the match is order-independent.
  let best: VertexRef | null = null
  for (const key of VERTEX_POINT_KEYS) {
    if (bare.length > key.length && bare.endsWith(key)) {
      const eid = bare.slice(0, -key.length)
      if (knownIds.has(eid) && (!best || eid.length > best.entityId.length)) {
        best = { entityId: eid, vertexKey: key }
      }
    }
  }
  return best
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
