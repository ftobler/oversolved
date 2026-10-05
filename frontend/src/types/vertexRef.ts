// Single source for the vertex-ref `knownIds` reader. Four call sites each used
// to parse the same wire form (`$<eid><vertexKey>` string and the resolved
// `{entity, point}` dict) against a set of known entity ids, and their tie-break
// had already drifted: offsetProfile preferred the longest eid while the other
// three returned the first VERTEX_POINT_KEYS match. They are now thin wrappers
// over this one function so the ambiguity rule cannot diverge again.
import { VERTEX_POINT_KEYS } from './vertexKeys'

export interface VertexRefPoint {
  entity: string
  point?: string
}

const VERTEX_KEY_SET: ReadonlySet<string> = new Set(VERTEX_POINT_KEYS)

/** Parse a constraint/query ref to `{entity, point?}`, or null when it does not
 *  name a known entity. Two forms are accepted:
 *
 *  - `{entity, point}`: `entity` must be a known id; a present `point` must be a
 *    VERTEX_POINT_KEYS member, while an absent one stays a bare (whole-curve)
 *    ref. An unvalidated point name would lower to an absent selector in the
 *    solver, silently weakening an endpoint constraint, so it is rejected.
 *  - `$<eid><vertexKey>`: a full string that names a known entity resolves as
 *    that whole id first (wire-format-hardening: minted base64url ids routinely
 *    end in a vertex-key word). Only when the full string is not an entity do we
 *    split a known suffix. If more than one split lands on a known id (possible
 *    only with adversarial ids), the longest eid (shortest key) wins, so the
 *    result is independent of VERTEX_POINT_KEYS order.
 *
 *  Callers add their own extras on top (e.g. `@builtin_origin` in
 *  partDocToSketches, dict passthrough in geometryMapping). */
export function resolveVertexRef(knownIds: ReadonlySet<string>, ref: unknown): VertexRefPoint | null {
  if (ref && typeof ref === 'object') {
    const obj = ref as { entity?: unknown; point?: unknown }
    if (typeof obj.entity !== 'string' || !knownIds.has(obj.entity)) return null
    if (obj.point == null) return { entity: obj.entity }
    if (typeof obj.point === 'string' && VERTEX_KEY_SET.has(obj.point)) {
      return { entity: obj.entity, point: obj.point }
    }
    return null
  }
  if (typeof ref !== 'string' || !ref.startsWith('$')) return null
  const bare = ref.slice(1)
  if (knownIds.has(bare)) return { entity: bare }
  let best: VertexRefPoint | null = null
  for (const key of VERTEX_POINT_KEYS) {
    if (bare.length > key.length && bare.endsWith(key)) {
      const eid = bare.slice(0, -key.length)
      if (knownIds.has(eid) && (!best || eid.length > best.entity.length)) {
        best = { entity: eid, point: key }
      }
    }
  }
  return best
}
