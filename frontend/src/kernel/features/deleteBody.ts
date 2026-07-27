// Removes one or more bodies from the store. A `?...` query resolves to a body
// (or a dict carrying body_id); otherwise the ref resolves directly. The TS port
// also releases each body's HandleTable handle (Python relies on GC).

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'
import type { Repository } from '../query'
import { resolveBody, resolveBodyIds } from './shared'

type Dict = Record<string, unknown>

interface DeleteBodyResult {
  status: string
  deleted_body_ids: string[]
}

/**
 * Resolve one body ref to the store keys it names, throwing when it names none.
 *
 * A `?` query is body-exact -- it resolves through a specific face/edge, so it
 * names the one sibling that owns it, and that is what the UI picker writes. A
 * plain ref may instead name a FEATURE, and a feature owns every body it made
 * (features/bodySplit.ts): `delete_body: {bodies: ['@extrude1']}` has to remove
 * `body_extrude1` AND its split siblings, not quietly leave the other halves
 * standing. `resolveBody` is still the fallback for the viewport-prefix forms
 * (`face:id:...`) it alone understands.
 */
function resolveBodyKeys(bodyQuery: string, globalRepo: Repository, bodyStore: Record<string, Body>): string[] {
  if (!bodyQuery.startsWith('?')) {
    const ids = resolveBodyIds(bodyQuery, bodyStore)
    return ids.length > 0 ? ids : [resolveBody(bodyQuery, bodyStore).id]
  }
  const resolved = globalRepo.query(bodyQuery, null, bodyStore) as Dict | null
  if (resolved === null) throw new Error(`delete_body: body not found: ${JSON.stringify(bodyQuery)}`)
  // A resolved Body carries created_by + id; a geometry dict carries body_id.
  if ('created_by' in resolved && typeof resolved.id === 'string') return [resolved.id]
  if (resolved.body_id) return [String(resolved.body_id)]
  throw new Error(`delete_body: query did not resolve to a body: ${JSON.stringify(bodyQuery)}`)
}

/** Solve a delete_body feature (mirrors `_solve_delete_body`). */
export function solveDeleteBody(
  _oc: OccModule,
  _scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
): DeleteBodyResult {
  const sub = (feature.delete_body as Dict) ?? {}
  const bodyQueries = (sub.bodies as string[]) ?? []

  // Resolve every ref against the intact store before removing anything: two
  // picks landing on the same body (different faces) must collapse into one
  // deletion instead of letting the second ref fail against an emptied slot.
  const keys: string[] = []
  for (const bodyQuery of bodyQueries) {
    for (const key of resolveBodyKeys(bodyQuery, globalRepo, bodyStore)) {
      if (!keys.includes(key)) keys.push(key)
    }
  }

  for (const bodyKey of keys) {
    const body = bodyStore[bodyKey]
    if (body !== undefined && body.shape !== null) table.release(body.shape)
    delete bodyStore[bodyKey]
  }
  return { status: 'ok', deleted_body_ids: keys }
}
