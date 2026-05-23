import type { PartDoc, PartFeature, PartConstraint, PartTarget } from '@/types/cad'
import { selectionToQuery, parseSelectionId } from '@/utils/selectionId'
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
  if (t.startsWith('@')) return t  // builtin/absolute query — pass through as-is
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

export function normalizeExtrudeSketch(sketch: string | string[]): string[] {
  if (Array.isArray(sketch)) return sketch
  return sketch ? [sketch] : []
}

export function normalizeRevolveSketch(sketch: string | string[]): string[] {
  if (Array.isArray(sketch)) return sketch
  return sketch ? [sketch] : []
}
