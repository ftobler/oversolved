import type { PartDoc, PartFeature, PartConstraint, PartEntityDef, PartTarget } from '@/types/cad'
import { VERTEX_POINT_KEYS } from '@/types/vertexKeys'
import { selectionToQuery, parseSelectionId, stripSelectionWrapper } from '@/utils/query/selectionId'
import { emitWire } from '@/utils/query'

export const warn = import.meta.env.DEV ? (...args: unknown[]) => console.warn(...args) : () => undefined

export const round = (v: number) => Math.round(v * 1e6) / 1e6

/** Boundary gate for every coordinate tuple a mutation persists. round(NaN) is
 *  still NaN and Math.min/max propagate it, so the clamps and rounds downstream
 *  are not gates themselves: a non-finite number has to be refused where it
 *  enters the document, or it survives into the YAML and every later solve. */
export const allFinite = (vs: readonly number[]) => vs.every(v => Number.isFinite(v))

export function findFeature(doc: PartDoc, featureId: string): PartFeature | undefined {
  return doc.features?.find(f => f.id === featureId)
}

/** Convert a selection ID to a query string.
 *  If the target belongs to a different feature than the host, use `@<featId>/<eleId>[/<sub>]`
 *  (absolute ref, slash-joined). Otherwise use `$<eleId>` (local ref).
 *  For `face:`/`edge:` IDs, returns the raw ancestry query verbatim (already globally scoped).
 *
 *  entity/vertex IDs are serialized through the query engine (selectionToQuery +
 *  emitWire) rather than hand-built here, so the `@`/`$` wire format lives in one
 *  place (kernel/query.ts, re-exported by utils/query). face/edge wrappers and the
 *  lenient `@`/`$` fallbacks are stripped through the shared wrapper stripper
 *  (selectionId.ts stripSelectionWrapper) rather than a hand-rolled split.
 *
 *  An input that already carries the `$` local prefix is passed through
 *  unchanged, so re-running a persisted local ref through parseTarget is a
 *  no-op rather than a double-`$` corruption. */
export const parseTarget = (t: string, hostFeatureId: string): PartTarget => {
  if (t.startsWith('entity:') || t.startsWith('vertex:')) {
    return emitWire(selectionToQuery(parseSelectionId(t), hostFeatureId))
  }
  if (t.startsWith('face:') || t.startsWith('edge:')) return stripSelectionWrapper(t)
  if (t.startsWith('@')) return t  // builtin/absolute query, pass through as-is
  if (t.startsWith('$')) return t  // already a host-local wire ref; re-targeting a stored ref must not add a second $
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

// Constraint fields that can carry an entity ref. Deletion GC (sketch.ts) and
// solve-result cleanup (solveResult.ts) must agree on what names an entity, so
// the key list lives here rather than as two hand-maintained copies.
export const CONSTRAINT_REF_FIELDS: (keyof PartConstraint)[] = [
  'target', 'a', 'b', 'line', 'arc', 'point', 'point_a', 'point_b',
]

// True when a stored wire-format ref addresses entityId: either the bare form
// `$<eid>` or a vertex sub-point `$<eid><vertexKey>`. Exact-or-known-suffix,
// not startsWith -- ids are random base64url so prefixes never collide in
// practice, but hand-authored YAML and human-readable fixture ids ($l10 vs $l1)
// do. Cross-sketch `@` refs and non-ref strings never match.
export function refMatchesEntity(ref: unknown, entityId: string): boolean {
  if (typeof ref !== 'string' || !ref.startsWith('$')) return false
  const bare = ref.slice(1)
  if (bare === entityId) return true
  if (!bare.startsWith(entityId)) return false
  return (VERTEX_POINT_KEYS as readonly string[]).includes(bare.slice(entityId.length))
}
