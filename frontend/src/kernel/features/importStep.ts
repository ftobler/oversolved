// Decodes base64 STEP data, reads it into a shape (optionally scaled), and registers a
// body per solid found in it. The STEP parse itself lives in occ/stepIo.ts.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'
import type { Repository } from '../query'
import { base64ToBytes, stepBytesToShapeWithIdentity } from '../occ/stepIo'
import { importedNameMaps } from '../occ/importLineage'
import { registerSplitBodies } from './bodySplit'

type Dict = Record<string, unknown>

interface ImportStepResult {
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
): ImportStepResult {
  const featureId = (feature.id as string) ?? ''
  const fileDataB64 = (feature.file_data as string) ?? ''
  const scale = Number(feature.scale ?? 1.0)

  if (!fileDataB64) throw new Error("import_step: requires 'file_data'")

  const bytes = base64ToBytes(fileDataB64)
  const bodyId = 'body_' + featureId
  const { shape: read, faceStepIds } = stepBytesToShapeWithIdentity(oc, scope, bytes, scale)
  const shape = scope.track(read)

  // Named from the STEP file's own entity ids. Without this every face of the
  // import shares one query string (`@<feature>@<body>`) and none of them is
  // individually selectable -- see occ/importLineage.ts. Computed on the whole
  // shape; `registerSplitBodies` narrows the maps per sibling.
  const names = importedNameMaps(oc, scope, shape, faceStepIds, featureId)

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
