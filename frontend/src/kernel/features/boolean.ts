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

import { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body, BrepDiff } from '../types3d'
import type { Repository } from '../query'
import { resolveBody, brepDiffIsEmpty } from './shared'
import { booleanWithDiff, volumeOf } from '../occ/booleans'
import { resplitBody } from './bodySplit'
import { transferBooleanNames } from './booleanLineage'

type Dict = Record<string, unknown>

interface BooleanResult {
  status: string
  body_id: string
  body_ids: string[]
  operation: string
  solver_warning?: string
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
  let foldedAny = false
  // Folded across the tools: each step's output names are the next step's target
  // names, so a face keeps its identity through a multi-tool boolean.
  let faceNames = targetBody.face_names ?? {}
  let faceAncestry = targetBody.face_ancestry ?? {}
  let edgeNames = targetBody.edge_names ?? {}
  let edgeAncestry = targetBody.edge_ancestry ?? {}
  const result: BooleanResult = { status: 'ok', body_id: targetBody.id, body_ids: [], operation }

  for (const toolRef of toolRefs) {
    const toolBody = resolveBody(toolRef, bodyStore)
    if (toolBody.shape === null) throw new Error(`boolean: tool '${toolRef}' has no shape`)
    const toolShape = table.get<OccShape>(toolBody.shape)
    const unifyFaces = !(targetBody.imported || toolBody.imported)

    // Mirror the implicit cut/add guards (bodyOps.applyBodyOperation): probe the
    // overlap before folding so a disjoint tool is neither consumed nor left
    // silent. A subtract of a non-overlapping tool would otherwise eat the body
    // with no visible effect; an intersect of disjoint bodies yields an empty
    // compound that must not be reported as 'ok'.
    if (op === 'cut' || op === 'common') {
      const probe = new DisposeScope()
      let intersects = true
      try {
        const { shape: inter } = booleanWithDiff(oc, probe, resultShape, toolShape, 'common', { unifyFaces })
        if (volumeOf(oc, probe, inter) < 1e-10) intersects = false
      } catch {
        // A failed probe is not evidence of disjointness: let the real boolean
        // run and surface its own failure rather than skipping the tool.
        intersects = true
      } finally {
        probe.dispose()
      }
      if (!intersects) {
        result.solver_warning = `${operation}: tool '${toolRef}' does not intersect the target; skipped`
        continue
      }
    }

    const res = booleanWithDiff(oc, scope, resultShape, toolShape, op, { unifyFaces })
    resultShape = scope.track(res.shape)
    const names = transferBooleanNames(oc, scope, {
      bodyShape: resultShape,
      faceOrigin: res.faceOrigin,
      targetFaceNames: faceNames,
      targetFaceAncestry: faceAncestry,
      toolFaceNames: toolBody.face_names ?? null,
      toolFaceAncestry: toolBody.face_ancestry ?? null,
      toolUuidScope: keepTools ? featureId : null,
    })
    faceNames = names.face_names
    faceAncestry = names.face_ancestry
    edgeNames = names.edge_names
    edgeAncestry = names.edge_ancestry
    lastDiff = res.diff
    foldedAny = true
    if (!keepTools) consumedKeys.push(toolBody.id)
  }

  targetBody.modified_by.push(featureId)
  targetBody.brep_diff = lastDiff
  targetBody.face_names = faceNames
  targetBody.face_ancestry = faceAncestry
  targetBody.edge_names = edgeNames
  targetBody.edge_ancestry = edgeAncestry

  // Mirror the implicit cut/add warning: a boolean that consumed a tool but left
  // the target's brep_diff untouched produced no real geometry change.
  if (foldedAny && lastDiff !== null && brepDiffIsEmpty(lastDiff)) {
    const msg = `${operation}: operation produced no geometry change`
    result.solver_warning = result.solver_warning === undefined ? msg : `${result.solver_warning}; ${msg}`
  }

  // An intersect of disjoint bodies yields an empty compound; name it so the
  // empty result is not silently reported as a successful boolean.
  if (op === 'common' && foldedAny && result.solver_warning === undefined) {
    const probe = new DisposeScope()
    try {
      if (volumeOf(oc, probe, resultShape) < 1e-10) {
        result.solver_warning = `${operation}: operation produced no overlapping geometry (empty result)`
      }
    } catch {
      // Volume probe failed; leave without the warning.
    } finally {
      probe.dispose()
    }
  }

  // Drop consumed tool bodies (release their handles first). Dedup so a tool
  // listed twice is not double-released. This has to happen BEFORE the resplit:
  // the target already carries the tools' face UUIDs (committed above), and the
  // build loop evicts a consumed tool's registrations by watching it leave the
  // store. If `resplitBody` throws -- `orderSolids` refuses a near-tie loudly --
  // a tool still in the store would leave that UUID naming two live faces with
  // nothing left to notice. Nothing between here and the resplit reads a tool.
  for (const key of new Set(consumedKeys)) {
    const tool = bodyStore[key]
    if (tool !== undefined) {
      if (tool.shape !== null) table.release(tool.shape)
      delete bodyStore[key]
    }
  }

  const bodyIds = resplitBody(oc, scope, table, bodyStore, targetBody, resultShape, featureId)

  result.body_ids = bodyIds
  return result
}
