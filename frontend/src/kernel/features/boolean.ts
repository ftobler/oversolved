// Port of `_solve_boolean` (solver_features_boolean.py): the explicit boolean
// leaf (union / subtract / intersect of whole bodies, vs the implicit cut/add an
// extrude does). It resolves a target body and a list of tool bodies, folds each
// tool into the target via booleanWithDiff, removes consumed tools, and (for
// subtract) splits any disconnected result solids into extra bodies.
//
// Unlike bodyOps' cut/add this does NOT transfer per-entity lineage: the target
// keeps its (now partly stale) lineage dicts, matching Python's single-op-history
// behaviour. Only the LAST tool's brep_diff is retained.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body, BrepDiff } from '../types3d'
import type { Repository } from '../query'
import { resolveBody } from './shared'
import { booleanWithDiff, exploreSolids } from '../occ/booleans'

type Dict = Record<string, unknown>

export interface BooleanResult {
  status: string
  body_id: string
  body_ids: string[]
  operation: string
}

const OP_MAP: Record<string, 'fuse' | 'cut' | 'common'> = {
  union: 'fuse',
  subtract: 'cut',
  intersect: 'common',
}

function bareBody(id: string, createdBy: string, sketchId: string): Body {
  // Mirrors Python Body(id, created_by, shape, sketch_id) with field defaults
  // (shape is assigned by the caller after registration).
  return {
    id,
    created_by: createdBy,
    modified_by: [],
    shape: null,
    sketch_id: sketchId,
    brep_diff: null,
    profile_queries: [],
    face_lineage: {},
    edge_lineage: {},
  }
}

/** Solve a boolean feature into the body store (mirrors `_solve_boolean`). */
export function solveBoolean(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  _globalRepo: Repository,
  bodyStore: Record<string, Body>,
): BooleanResult {
  const featureId = (feature.id as string) ?? ''
  const sub = (feature.boolean as Dict) ?? {}
  const operation = (sub.operation as string) ?? 'union'
  const targetRef = (sub.target as string) ?? ''
  const toolRefs = (sub.tools as string[]) ?? []
  const keepTools = (sub.keep_tools as boolean) ?? false

  if (!targetRef) throw new Error("boolean: 'target' is required")
  if (toolRefs.length === 0) throw new Error("boolean: 'tools' must have at least one entry")

  const op = OP_MAP[operation]
  if (op === undefined) throw new Error(`boolean: unknown operation '${operation}'`)

  const targetBody = resolveBody(targetRef, bodyStore)
  if (targetBody.shape === null) throw new Error(`boolean: target '${targetRef}' has no shape`)

  let resultShape: OccShape = table.get<OccShape>(targetBody.shape)
  const consumedKeys: string[] = []
  let lastDiff: BrepDiff | null = null

  for (const toolRef of toolRefs) {
    const toolBody = resolveBody(toolRef, bodyStore)
    if (toolBody.shape === null) throw new Error(`boolean: tool '${toolRef}' has no shape`)
    const toolShape = table.get<OccShape>(toolBody.shape)
    const res = booleanWithDiff(oc, scope, resultShape, toolShape, op)
    resultShape = scope.track(res.shape)
    lastDiff = res.diff
    if (!keepTools) consumedKeys.push(toolBody.id)
  }

  targetBody.modified_by.push(featureId)
  targetBody.brep_diff = lastDiff

  const oldHandle = targetBody.shape
  const bodyIds: string[] = [targetBody.id]

  if (operation === 'subtract') {
    const solids = exploreSolids(oc, scope, resultShape)
    if (solids.length > 1) {
      targetBody.shape = table.register(scope.detach(solids[0]), targetBody.created_by)
      for (let i = 1; i < solids.length; i++) {
        let suffix = i
        while (`${targetBody.id}_${suffix}` in bodyStore) suffix++
        const newBid = `${targetBody.id}_${suffix}`
        bodyStore[newBid] = bareBody(newBid, targetBody.created_by, targetBody.sketch_id)
        bodyStore[newBid].shape = table.register(scope.detach(solids[i]), targetBody.created_by)
        bodyIds.push(newBid)
      }
    } else {
      targetBody.shape = table.register(scope.detach(resultShape), targetBody.created_by)
    }
  } else {
    targetBody.shape = table.register(scope.detach(resultShape), targetBody.created_by)
  }
  table.release(oldHandle)

  // Drop consumed tool bodies (release their handles first). Dedup so a tool
  // listed twice is not double-released.
  for (const key of new Set(consumedKeys)) {
    const tool = bodyStore[key]
    if (tool !== undefined) {
      if (tool.shape !== null) table.release(tool.shape)
      delete bodyStore[key]
    }
  }

  return { status: 'ok', body_id: targetBody.id, body_ids: bodyIds, operation }
}
