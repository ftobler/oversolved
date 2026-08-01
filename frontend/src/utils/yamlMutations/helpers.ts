import type { PartDoc, PartFeature, PartConstraint, PartEntityDef, PartTarget } from '@/types/cad'
import { selectionToQuery, parseSelectionId } from '@/utils/query/selectionId'
import { emitWire } from '@/utils/query'

export const warn = import.meta.env.DEV ? (...args: unknown[]) => console.warn(...args) : () => undefined

export const round = (v: number) => Math.round(v * 1e6) / 1e6

export function findFeature(doc: PartDoc, featureId: string): PartFeature | undefined {
  return doc.features?.find(f => f.id === featureId)
}

/** Convert a selection ID to a query string.
 *  If the target belongs to a different feature than the host, use `@<featId><eleId>`
 *  (absolute ref). Otherwise use `$<eleId>` (local ref).
 *  For `face:` IDs, returns the raw ancestry query verbatim (already globally scoped).
 *
 *  entity/vertex IDs are serialized through the query engine (selectionToQuery +
 *  emitWire) rather than hand-built here, so the `@`/`$` wire format lives in one
 *  place. face passthrough and the lenient `@`/`$` fallbacks are kept as-is. */
export const parseTarget = (t: string, hostFeatureId: string): PartTarget => {
  if (t.startsWith('entity:') || t.startsWith('vertex:')) {
    return emitWire(selectionToQuery(parseSelectionId(t), hostFeatureId))
  }
  if (t.startsWith('face:')) return t.split(':').slice(2).join(':')
  if (t.startsWith('@')) return t  // builtin/absolute query, pass through as-is
  return '$' + t
}

// Generate a random base64url ID.  bytes=12 for elements, bytes=18 for features.
export function randomId(bytes: number): string {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

export function uniqueConstraintId(constraints: PartConstraint[], kind: string): string {
  const existing = new Set(constraints.map(c => c.id))
  let id = `c_${kind}_${randomId(6)}`
  while (existing.has(id)) id = `c_${kind}_${randomId(6)}`
  return id
}

/** `count` fresh entity ids, colliding with neither an existing entity nor each
 *  other. The sugar mutations mint their whole run up front because they need the
 *  ids as an array before the push loop is written -- a rectangle names all four
 *  lines while constraining them to one another. Callers that push each entity as
 *  they go want `mintEntityId` against the live list instead. */
export function freshEntityIds(entities: PartEntityDef[], count: number): string[] {
  const existing = new Set(entities.map(e => e.id))
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    let id = randomId(12)
    while (existing.has(id)) id = randomId(12)
    existing.add(id)
    ids.push(id)
  }
  return ids
}

/** The id for one new entity. A supplied `given` is taken verbatim, NOT re-rolled:
 *  a caller only supplies one when it must reference the entity right away (the
 *  dimension tool targets the projection it makes in the same click), and a
 *  re-roll would orphan the reference it already holds. So a supplied id must
 *  already be unique within the feature. */
export function mintEntityId(entities: PartEntityDef[], given?: string): string {
  return given ?? freshEntityIds(entities, 1)[0]
}

// Coerce a feature ref field (single query, list, or empty) into a query list.
export function normalizeRefList(ref: string | string[] | undefined): string[] {
  if (Array.isArray(ref)) return ref
  return ref ? [ref] : []
}
