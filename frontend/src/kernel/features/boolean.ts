// The explicit boolean leaf (union / subtract / intersect of whole bodies, vs the implicit
// cut/add an extrude does). It resolves a target body and a list of tool bodies, folds each
// tool into the target via booleanWithDiff, removes consumed tools, and splits any
// disconnected result solids into extra bodies.
//
// The split used to be limited to `subtract`, on the assumption that only a cut can
// disconnect a body. It cannot: a union of two bodies that do not touch is a two-solid
// compound, and an intersect can leave several lumps just as a cut can. Every operation now
// goes through `resplitBody`.
//
// Construction names are folded through the tool loop the same way bodyOps' cut/add and the
// array fuse do: each `booleanWithDiff` hands back a faceOrigin map, and `transferBooleanNames`
// carries the accumulated names onto the new shape by subshape identity. Skipping that (which
// this leaf used to do, keeping the target's now-stale geom-hash keys) silently unnamed every
// face the boolean reshaped, and every edge around them with it. Only the LAST tool's brep_diff
// is retained.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body, BrepDiff } from '../types3d'
import type { Repository } from '../query'
import { resolveBody } from './shared'
import { booleanWithDiff } from '../occ/booleans'
import { resplitBody } from './bodySplit'
import { transferBooleanNames } from './booleanLineage'

type Dict = Record<string, unknown>

interface BooleanResult {
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
  // Folded across the tools: each step's output names are the next step's target
  // names, so a face keeps its identity through a multi-tool boolean.
  let faceNames = targetBody.face_names ?? {}
  let faceAncestry = targetBody.face_ancestry ?? {}
  let edgeNames = targetBody.edge_names ?? {}
  let edgeAncestry = targetBody.edge_ancestry ?? {}

  for (const toolRef of toolRefs) {
    const toolBody = resolveBody(toolRef, bodyStore)
    if (toolBody.shape === null) throw new Error(`boolean: tool '${toolRef}' has no shape`)
    const toolShape = table.get<OccShape>(toolBody.shape)
    const res = booleanWithDiff(oc, scope, resultShape, toolShape, op)
    resultShape = scope.track(res.shape)
    const names = transferBooleanNames(oc, scope, {
      bodyShape: resultShape,
      faceOrigin: res.faceOrigin,
      targetFaceNames: faceNames,
      targetFaceAncestry: faceAncestry,
      toolFaceNames: toolBody.face_names ?? null,
      toolFaceAncestry: toolBody.face_ancestry ?? null,
    })
    faceNames = names.face_names
    faceAncestry = names.face_ancestry
    edgeNames = names.edge_names
    edgeAncestry = names.edge_ancestry
    lastDiff = res.diff
    if (!keepTools) consumedKeys.push(toolBody.id)
  }

  targetBody.modified_by.push(featureId)
  targetBody.brep_diff = lastDiff
  targetBody.face_names = faceNames
  targetBody.face_ancestry = faceAncestry
  targetBody.edge_names = edgeNames
  targetBody.edge_ancestry = edgeAncestry

  const bodyIds = resplitBody(oc, scope, table, bodyStore, targetBody, resultShape, featureId)

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
