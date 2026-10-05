// Type hierarchy, element classification and cross-kind coercion for the query
// resolver. Split out of query.ts so the Repository engine stays under the
// project's soft file-size limit; Repository imports these back.

import { failLoud } from '@/utils/invariants'
import type { Repository } from './queryRepository'

export class AmbiguousQueryError extends Error {}

// ─── Type hierarchy ───

const TYPE_HIERARCHY: Record<string, string[]> = {
  solid: [],
  face: [],
  flatface: ["face"],
  cylinderface: ["face"],
  coneface: ["face"],
  sphereface: ["face"],
  torusface: ["face"],
  edge: [],
  straightedge: ["edge"],
  vertex: [],
}

export function isSubtype(actualType: string | null, targetType: string): boolean {
  if (actualType === null) return false
  if (actualType === targetType) return true
  return (TYPE_HIERARCHY[actualType] ?? []).includes(targetType)
}

export function objType(obj: unknown): string | null {
  if (obj !== null && typeof obj === "object") {
    const t = (obj as Record<string, unknown>)["type"]
    return typeof t === "string" ? t : null
  }
  return null
}

export function isDict(obj: unknown): obj is Record<string, unknown> {
  return obj !== null && typeof obj === "object" && !Array.isArray(obj)
}

/** The body's `modified_by` feature chain from the store, or null when absent. */
function bodyModifiersOf(
  bodyStore: Record<string, unknown> | null,
  bodyId: unknown,
): string[] | null {
  if (bodyStore === null) return null
  const body = bodyStore[bodyId as string]
  if (!isDict(body)) return null
  const mods = body["modified_by"]
  return Array.isArray(mods) ? (mods as string[]) : null
}

/** Attempt to coerce element to targetType using bodyStore and the repository.
 *  `orderFilter` is the caller's ordering guard: the coerce scan walks the
 *  lineage independently of the ancestry-tier candidate filter, so it must apply
 *  the same owner-order rule or a coerced sibling could belong to a feature
 *  ordered after the current one (the forward-geometry hazard). The upward
 *  `:solid` branch returns the body straight from the body store and stays
 *  deliberately exempt from the owner-order rule. */
export function coerceType(
  element: unknown,
  targetType: string,
  bodyStore: Record<string, unknown> | null,
  repo: Repository,
  queryIds: ReadonlySet<string>,
  orderFilter: (eids: string[]) => string[],
): unknown {
  if (element === null || element === undefined) return null
  const ot = objType(element)
  if (ot === null) return null
  if (ot === targetType || isSubtype(ot, targetType)) return element
  if (!isDict(element)) return null
  const bodyId = element["body_id"]
  if (bodyId === null || bodyId === undefined) return null
  const createdBy = element["created_by"]
  if (createdBy === null || createdBy === undefined) return null
  // Upward: child -> solid. The store is the only source of the solid; every
  // solve-time call site threads it, so a null/empty store is a wiring bug and
  // fails loud in dev/test instead of silently returning null.
  if (targetType === "solid") {
    if (bodyStore === null || Object.keys(bodyStore).length === 0) {
      failLoud(
        `coerceType: upward :solid coercion requested with no body store ` +
          `(body ${JSON.stringify(bodyId)})`,
      )
      return null
    }
    return bodyStore[bodyId as string] ?? null
  }
  // Downward / sibling: scope to the query's ancestry so a coerced sibling is
  // provably in the query's lineage. Only entries sharing a nonHash query token
  // are reachable through byAncestorId, so no element outside the lineage is
  // even examined. A body's modified_by chain admits a sibling created by a
  // different feature (a fillet-created face coerces to a same-body edge the
  // original feature made).
  const matches: unknown[] = []
  const seen = new Set<unknown>()
  const bodyMods = bodyModifiersOf(bodyStore, bodyId)
  const keys = new Set<string>()
  for (const qid of queryIds) {
    const tagged = repo.byAncestorId.get(qid)
    if (tagged) for (const k of tagged) keys.add(k)
  }
  for (const key of keys) {
    const entry = repo.ancestral.get(key)
    if (entry === undefined) continue
    for (const eid of entry.eids) {
      const el = repo.elements.get(eid)
      if (el === undefined || el === element) continue
      if (!isDict(el)) continue
      if (el["body_id"] !== bodyId) continue
      const elType = objType(el)
      if (!(elType === targetType || isSubtype(elType, targetType))) continue
      const elCreatedBy = el["created_by"]
      if (typeof elCreatedBy !== "string") continue
      if (elCreatedBy !== createdBy && !(bodyMods !== null && bodyMods.includes(elCreatedBy))) {
        continue
      }
      if (orderFilter([eid]).length === 0) continue  // ordering guard: the sibling is not visible from here yet
      if (!seen.has(el)) {
        seen.add(el)
        matches.push(el)
      }
    }
  }
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    throw new AmbiguousQueryError(
      `Query coerced to ${matches.length} distinct '${targetType}' elements ` +
        `in body ${JSON.stringify(bodyId)}`,
    )
  }
  return null
}
