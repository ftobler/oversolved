// Reads STEP bytes (optionally scaled) into a shape and registers a body per
// solid found in it. The bytes arrive in the solve file map, keyed by the
// feature's `file_id`; the STEP parse itself lives in occ/stepIo.ts.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'
import type { Repository } from '../query'
import { stepBytesToShapeWithIdentity } from '../occ/stepIo'
import { importedNameMaps } from '../occ/importLineage'
import { registerSplitBodies, splitSolids } from './bodySplit'

type Dict = Record<string, unknown>

interface ImportStepResult {
  [key: string]: unknown
  status: string
  // The first body, kept for callers that want a single handle on the import.
  body_id: string
  body_ids: string[]
}

/** Solve an import_step feature (mirrors `_solve_import_step`). */
export function solveImportStep(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  _globalRepo: Repository,
  bodyStore: Record<string, Body>,
  files?: ReadonlyMap<string, Uint8Array>,
): ImportStepResult {
  const featureId = (feature.id as string) ?? ''
  const fileId = (feature.file_id as string) ?? ''
  const scale = Number(feature.scale ?? 1.0)
  // A non-finite or non-positive scale would flow unchecked into the placement
  // identity computation: 0 reaches gp_Trsf.SetScale, whose inverse divides by
  // the factor, and a negative factor is a central inversion the import UI
  // never offers. Both are refused by name here.
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(`import_step: scale must be a positive finite number, got ${feature.scale}`)
  }

  // A pre-cut document carries the bytes inline. Refuse it by name rather than
  // solving an empty import; there is no migration (A2). This must precede the
  // file_id check: such a document has file_data and no file_id, so the
  // requires-file_id diagnostic would blame the wrong thing.
  if (typeof feature.file_data === 'string' && feature.file_data.length > 0) {
    throw new Error("import_step: inline 'file_data' is no longer supported; re-import the STEP file "
      + `(file_id: ${fileId || 'none'})`)
  }
  if (!fileId) throw new Error("import_step: requires 'file_id'")

  const bytes = files?.get(fileId)
  if (!bytes) throw new Error(`import_step: file '${fileId}' is not present in the solve file set`)

  const bodyId = 'body_' + featureId
  const { shape: read, faceStepIds } = stepBytesToShapeWithIdentity(oc, scope, bytes, scale)
  const shape = scope.track(read)

  // Named from the STEP file's own entity ids. Without this every face of the
  // import shares one query string (`@<feature>@<body>`) and none of them is
  // individually selectable -- see occ/importLineage.ts. Computed on the whole
  // shape; `registerSplitBodies` narrows the maps per sibling. A repeated
  // instance (one part placed twice) shares its entity ids, so the per-solid
  // index from `splitSolids` -- the same order body ids are minted with -- is
  // folded into the UUID path to keep the copies' `@u|` tokens disjoint.
  const names = importedNameMaps(oc, scope, shape, faceStepIds, featureId, splitSolids(oc, scope, shape))

  // A STEP file holding several parts arrives as one compound, so the import is
  // exactly the "a shape becomes bodies" case bodySplit owns: one body per
  // solid, or one body carrying the whole shape when the file has no solid at
  // all (surfaces/shells only).
  const bodyIds = registerSplitBodies(oc, scope, table, bodyStore, shape, {
    id: bodyId,
    createdBy: featureId,
    imported: true,
    faceNames: names.faceNames,
    edgeNames: names.edgeNames,
    faceAncestry: names.faceAncestry,
    edgeAncestry: names.edgeAncestry,
  })
  return { status: 'ok', body_id: bodyIds[0], body_ids: bodyIds }
}
