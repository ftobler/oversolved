// The central add/cut/new body-store dispatch every leaf brep producer (extrude, revolve,
// hole,...) calls after building its tool shape. Mirrors the Python branch structure exactly.
//
// Ownership contract (the TS-specific part Python gets from GC): - `toolShape` is a raw
// OccShape the CALLER owns (built in the caller's scope). This function never registers the
// tool itself; for "new"/separate bodies it registers the extracted SOLIDS (detached from
// `scope`) and the caller disposes the tool afterwards. - Shapes that become a body's `.shape`
// are registered in the HandleTable (refcount 1, owner = the body's creating feature) and
// detached from `scope` so the scope's dispose() does not double-free them. When an existing
// body's shape is replaced (cut/add), its old handle is released. - `body.brep_diff`'s
// sub-shape handles are tracked in `scope`; they are read by the lineage transfer here, then
// remain valid only while `scope` is open. The builder keeps `scope` open across post-boolean
// ancestry registration (the same lifetime the diff already had in 2d's design).

import { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape } from '../occ/occTypes'
import type { Body } from '../types3d'
import type { OccHandle, HandleTable } from '../occ/handleTable'
import { resolveMergeTargets, brepDiffIsEmpty } from './shared'
import { booleanWithDiff, volumeOf, exploreSolids, countSolids } from '../occ/booleans'
import { transferBooleanLineage } from './booleanLineage'

export type BodyOperation = 'add' | 'cut' | 'new'

export interface ApplyBodyOperationInput {
  toolShape: OccShape
  bodyStore: Record<string, Body>
  operation: BodyOperation
  mergeTarget: string | null
  bodyId: string
  featureId: string
  sketchId: string
  opName?: string
  profileQueries?: string[]
  /** The tool body's per-face lineage (face_gh -> tokens). */
  faceLineage?: Record<string, string[]> | null
  /** The tool body's per-edge lineage. */
  edgeLineage?: Record<string, string[]> | null
}

export interface ApplyBodyOperationResult {
  status: string
  body_id: string
  operation?: string
  body_ids?: string[]
  solver_warning?: string
}

function newBody(
  id: string,
  createdBy: string,
  shape: OccHandle,
  sketchId: string,
  profileQueries: string[],
  faceLineage: Record<string, string[]>,
  edgeLineage: Record<string, string[]>,
): Body {
  return {
    id,
    created_by: createdBy,
    modified_by: [],
    shape,
    sketch_id: sketchId,
    brep_diff: null,
    profile_queries: [...profileQueries],
    face_lineage: { ...faceLineage },
    edge_lineage: { ...edgeLineage },
  }
}

/**
 * Apply a boolean body operation (add / cut / new) using `toolShape`.
 * Mirrors `_apply_body_operation`; raises (throws) for user-facing errors which
 * the caller catches and records as status. Guaranteed result keys: status,
 * body_id, operation.
 */
export function applyBodyOperation(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  input: ApplyBodyOperationInput,
): ApplyBodyOperationResult {
  const {
    toolShape,
    bodyStore,
    operation,
    mergeTarget,
    bodyId,
    featureId,
    sketchId,
    opName = '',
    profileQueries = [],
    faceLineage = null,
    edgeLineage = null,
  } = input

  const result: ApplyBodyOperationResult = { status: 'ok', body_id: bodyId }

  let needNewBody = false
  let targetIds: string[] = []
  if (operation === 'add' || operation === 'cut') {
    targetIds = resolveMergeTargets(mergeTarget, bodyStore)
    if (!targetIds.length && !mergeTarget && operation === 'add') {
      needNewBody = true
    } else {
      if (!targetIds.length && !mergeTarget && operation === 'cut') {
        // No bodies exist and no target specified: silently succeed.
        result.operation = 'cut'
        return result
      }
      if (!targetIds.length) {
        throw new Error(`${opName}: merge target '${mergeTarget}' not found`)
      }
    }
  }

  const tlFace = faceLineage ?? {}

  if (operation === 'cut') {
    let cutAnything = false
    let cutBodyId: string | null = null
    const cutBodyIds: string[] = []
    for (const bid of targetIds) {
      const existingBody = bodyStore[bid]
      if (existingBody.shape === null) continue
      const oldShape = table.get<OccShape>(existingBody.shape)
      // Skip targets the tool does not actually intersect (volume ~ 0).
      try {
        const probe = new DisposeScope()
        try {
          const { shape: inter } = booleanWithDiff(oc, probe, oldShape, toolShape, 'common')
          if (volumeOf(oc, probe, inter) < 1e-10) continue
        } finally {
          probe.dispose()
        }
      } catch {
        continue
      }

      const { shape: newShape, diff } = booleanWithDiff(oc, scope, oldShape, toolShape, 'cut')
      scope.track(newShape)
      const lineage = transferBooleanLineage(oc, scope, {
        bodyShape: newShape,
        diff,
        oldTargetShape: oldShape,
        toolShape,
        faceLineage: existingBody.face_lineage,
        toolFaceLineage: tlFace,
      })
      existingBody.modified_by.push(featureId)
      existingBody.brep_diff = diff
      existingBody.face_lineage = lineage.face_lineage
      existingBody.edge_lineage = lineage.edge_lineage

      cutAnything = true
      cutBodyIds.push(bid)
      if (cutBodyId === null) cutBodyId = bid

      const oldHandle = existingBody.shape
      const solids = exploreSolids(oc, scope, newShape)
      if (solids.length > 1) {
        existingBody.shape = table.register(scope.detach(solids[0]), existingBody.created_by)
        for (let i = 1; i < solids.length; i++) {
          let suffix = i
          while (`${bid}_${suffix}` in bodyStore) suffix++
          const newBid = `${bid}_${suffix}`
          bodyStore[newBid] = newBody(
            newBid,
            existingBody.created_by,
            table.register(scope.detach(solids[i]), existingBody.created_by),
            existingBody.sketch_id,
            [],
            {},
            {},
          )
          cutBodyIds.push(newBid)
        }
      } else {
        existingBody.shape = table.register(scope.detach(newShape), existingBody.created_by)
      }
      table.release(oldHandle)
    }
    if (!cutAnything) {
      throw new Error(`${opName}: cut does not intersect any target body - nothing to remove`)
    }
    result.body_id = cutBodyId as string
    result.body_ids = cutBodyIds
    result.operation = 'cut'
    const cutBody = cutBodyId !== null ? bodyStore[cutBodyId] : undefined
    if (cutBody && brepDiffIsEmpty(cutBody.brep_diff)) {
      result.solver_warning = `${opName}: operation produced no geometry change`
    }
    return result
  }

  if (operation === 'new') {
    const solids = exploreSolids(oc, scope, toolShape)
    const bodyIds: string[] = []
    solids.forEach((solid, i) => {
      const bid = i === 0 ? bodyId : `${bodyId}_${i}`
      bodyStore[bid] = newBody(
        bid,
        featureId,
        table.register(scope.detach(solid), featureId),
        sketchId,
        profileQueries,
        tlFace,
        edgeLineage ?? {},
      )
      bodyIds.push(bid)
    })
    result.body_id = bodyIds[0]
    result.body_ids = bodyIds
    result.operation = 'new'
    return result
  }

  // operation === 'add'
  let fused = false
  let fusedBodyId: string | null = null
  if (!needNewBody) {
    for (const bid of targetIds) {
      const existingBody = bodyStore[bid]
      if (existingBody.shape === null) continue
      const oldShape = table.get<OccShape>(existingBody.shape)
      let newShape: OccShape
      let diff
      try {
        const res = booleanWithDiff(oc, scope, oldShape, toolShape, 'fuse')
        newShape = res.shape
        diff = res.diff
      } catch (exc) {
        throw new Error(`${opName}: add operation failed: ${String(exc)}`)
      }
      scope.track(newShape)
      if (mergeTarget) {
        if (countSolids(oc, scope, newShape) > 1) {
          throw new Error(`${opName}: add would create island shape not touching target body`)
        }
      } else {
        // Default add (no explicit target): only fuse with a body the new solid
        // actually connects to. If the union stays disjoint (solid count does
        // not drop), the profile is a separate part; skip and let it be its own.
        const oldN = countSolids(oc, scope, oldShape)
        const toolN = countSolids(oc, scope, toolShape)
        if (countSolids(oc, scope, newShape) >= oldN + toolN) continue
      }
      const lineage = transferBooleanLineage(oc, scope, {
        bodyShape: newShape,
        diff,
        oldTargetShape: oldShape,
        toolShape,
        faceLineage: existingBody.face_lineage,
        toolFaceLineage: tlFace,
      })
      const oldHandle = existingBody.shape
      existingBody.shape = table.register(scope.detach(newShape), existingBody.created_by)
      table.release(oldHandle)
      existingBody.modified_by.push(featureId)
      existingBody.brep_diff = diff
      existingBody.face_lineage = lineage.face_lineage
      existingBody.edge_lineage = lineage.edge_lineage
      fused = true
      fusedBodyId = bid
      break
    }
  }

  if (fused) {
    result.body_id = fusedBodyId as string
    result.body_ids = [fusedBodyId as string]
    result.operation = 'add'
    const fusedBody = fusedBodyId !== null ? bodyStore[fusedBodyId] : undefined
    if (fusedBody && brepDiffIsEmpty(fusedBody.brep_diff)) {
      result.solver_warning = `${opName}: operation produced no geometry change`
    }
    return result
  }
  if (mergeTarget) {
    throw new Error(`${opName}: add could not fuse with any target body`)
  }
  // No target body: the tool becomes its own body (one per solid).
  const solids = exploreSolids(oc, scope, toolShape)
  const bodyIds: string[] = []
  solids.forEach((solid, i) => {
    const bid = i === 0 ? bodyId : `${bodyId}_${i}`
    bodyStore[bid] = newBody(
      bid,
      featureId,
      table.register(scope.detach(solid), featureId),
      sketchId,
      profileQueries,
      tlFace,
      edgeLineage ?? {},
    )
    bodyIds.push(bid)
  })
  result.body_id = bodyIds[0]
  result.body_ids = bodyIds
  result.operation = 'add'
  return result
}
