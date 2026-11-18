// Removes one or more bodies from the store. A `?...` query resolves to a body
// (or a dict carrying body_id); otherwise the ref resolves directly. The TS port
// also releases each body's HandleTable handle (Python relies on GC).

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { PartSolid } from '../types3d'
import type { Repository } from '../query'
import { clearConsumedPartAncestry } from '../query'
import { resolvePartRefList } from './shared/partResolution'

type Dict = Record<string, unknown>

interface DeletePartResult {
  [key: string]: unknown
  status: string
  deleted_body_ids: string[]
}

/** Solve a delete_body feature (mirrors `_solve_delete_body`). */
export function solveDeletePart(
  _oc: OccModule,
  _scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  globalRepo: Repository,
  partStore: Record<string, PartSolid>,
): DeletePartResult {
  const sub = (feature.delete_body as Dict) ?? {}
  const partQueries = (sub.bodies as string[]) ?? []

  // Resolves against the intact store before anything is removed, so two picks
  // landing on the same body (different faces) collapse into one deletion
  // instead of letting the second ref fail against an emptied slot.
  const keys = resolvePartRefList(partQueries, globalRepo, partStore, 'delete_body')

  for (const partKey of keys) {
    const part = partStore[partKey]
    if (part !== undefined && part.shape !== null) {
      // The owner tag is settled with the body, so a later `releaseOwner`
      // cannot over-decrement (see releaseFor).
      table.releaseFor(part.shape, part.modified_by.at(-1) ?? part.created_by)
    }
    if (part !== undefined) clearConsumedPartAncestry(globalRepo, part.id, part.created_by || '')
    delete partStore[partKey]
  }
  return { status: 'ok', deleted_body_ids: keys }
}
