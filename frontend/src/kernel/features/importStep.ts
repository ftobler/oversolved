// Decodes base64 STEP data, reads it into a shape (optionally scaled), and registers a
// body per solid found in it. The STEP parse itself lives in occ/stepIo.ts.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'
import type { Repository } from '../query'
import { base64ToBytes, stepBytesToShape } from '../occ/stepIo'
import { exploreSolids } from '../occ/booleans'

type Dict = Record<string, unknown>

interface ImportStepResult {
  status: string
  /** The first body, kept for callers that want a single handle on the import. */
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
  const shape = scope.track(stepBytesToShape(oc, scope, bytes, scale))

  // A STEP file holding several parts arrives as one compound, and this system
  // keeps disjoint solids as separate parts (the same split the boolean leaves
  // do), so each solid becomes its own body. A file with no solid at all
  // (surfaces/shells only) has nothing to split and stays one body carrying the
  // whole shape -- the pre-split behaviour, which also keeps a lone solid's
  // registered shape byte-identical to what it was before.
  const solids = exploreSolids(oc, scope, shape)
  const parts: OccShape[] = solids.length > 1 ? solids : [shape]

  const bodyIds = parts.map((part, i) => {
    const bid = i === 0 ? bodyId : `${bodyId}_${i}`
    bodyStore[bid] = {
      id: bid,
      created_by: featureId,
      modified_by: [],
      shape: table.register(scope.detach(part), featureId),
      sketch_id: '',
      brep_diff: null,
      profile_queries: [],
      imported: true,
    }
    return bid
  })
  return { status: 'ok', body_id: bodyIds[0], body_ids: bodyIds }
}
