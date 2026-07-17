// Decodes base64 STEP data, reads it into a shape (optionally scaled), and registers a new
// body. The STEP parse itself lives in occ/stepIo.ts.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'
import type { Repository } from '../query'
import { base64ToBytes, stepBytesToShape } from '../occ/stepIo'

type Dict = Record<string, unknown>

interface ImportStepResult {
  status: string
  body_id: string
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
  const shape = scope.track(stepBytesToShape(oc, scope, bytes, scale))

  bodyStore[bodyId] = {
    id: bodyId,
    created_by: featureId,
    modified_by: [],
    shape: table.register(scope.detach(shape), featureId),
    sketch_id: '',
    brep_diff: null,
    profile_queries: [],
    imported: true,
  }
  return { status: 'ok', body_id: bodyId }
}
