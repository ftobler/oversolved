import type { PartDoc, PartFeature, PartConstraint, PartTarget } from '@/types/cad'

export const warn = import.meta.env.DEV ? (...args: unknown[]) => console.warn(...args) : () => undefined

export const round = (v: number) => Math.round(v * 1e6) / 1e6

export function findFeature(doc: PartDoc, featureId: string): PartFeature | undefined {
  return doc.features?.find(f => f.id === featureId)
}

/** Convert a selection ID to a query string.
 *  If the target belongs to a different feature than the host, use `@<featId><eleId>`
 *  (absolute ref). Otherwise use `$<eleId>` (local ref).
 *  For `face:` IDs, returns the raw ancestry query verbatim (already globally scoped). */
export const parseTarget = (t: string, hostFeatureId: string): PartTarget => {
  const parts = t.split(':')
  if (parts[0] === 'entity') {
    const [, featId, eleId] = parts
    return featId === hostFeatureId ? '$' + eleId : '@' + featId + eleId
  }
  if (parts[0] === 'vertex') {
    const [, featId, eleId, sub] = parts
    return featId === hostFeatureId ? '$' + eleId + sub : '@' + featId + eleId + sub
  }
  if (parts[0] === 'face') return parts.slice(2).join(':')
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
