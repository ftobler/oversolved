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
import type { HandleTable } from '../occ/handleTable'
import { resolveMergeTargets, brepDiffIsEmpty } from './shared'
import { booleanWithDiff, volumeOf, countSolids } from '../occ/booleans'
import { transferBooleanNames } from './booleanLineage'
import { registerSplitBodies, resplitBody } from './bodySplit'

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
  // The tool body's construction-name maps (query-naming-by-construction).
  faceNames?: Record<string, string> | null
  edgeNames?: Record<string, string> | null
  faceAncestry?: Record<string, string[]> | null
  edgeAncestry?: Record<string, string[]> | null
}

export interface ApplyBodyOperationResult {
  status: string
  body_id: string
  operation?: string
  body_ids?: string[]
  solver_warning?: string
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
    faceNames = null,
    edgeNames = null,
    faceAncestry = null,
    edgeAncestry = null,
  } = input

  // The tool body's construction-name maps, carried onto a body the tool becomes
  // (the "new"/no-target paths) and narrowed per sibling when it splits. Boolean
  // paths (add/cut) rebuild them in Stage 2.
  const toolNames = { faceNames, edgeNames, faceAncestry, edgeAncestry }

  const result: ApplyBodyOperationResult = { status: 'ok', body_id: bodyId }

  let needNewBody = false
  let targetIds: string[] = []
  if (operation === 'add' || operation === 'cut') {
    targetIds = resolveMergeTargets(mergeTarget, bodyStore)
    if (!targetIds.length && !mergeTarget && operation === 'add') {
      needNewBody = true
    } else {
      if (!targetIds.length && !mergeTarget && operation === 'cut') {
        // No bodies exist and no target specified: silently succeed. `body_id`
        // keeps the id this feature WOULD have minted (parity with Python), so
        // `body_ids` has to be explicitly empty -- a consumer reading
        // `body_ids ?? [body_id]` would otherwise chase a body that was never
        // created.
        result.operation = 'cut'
        result.body_ids = []
        return result
      }
      if (!targetIds.length) {
        throw new Error(`${opName}: merge target '${mergeTarget}' not found`)
      }
    }
  }

  if (operation === 'cut') {
    let cutAnything = false
    let cutBodyId: string | null = null
    const cutBodyIds: string[] = []
    for (const bid of targetIds) {
      const existingBody = bodyStore[bid]
      if (existingBody.shape === null) continue
      const oldShape = table.get<OccShape>(existingBody.shape)
      // Skip targets the tool does not actually intersect (volume ~ 0).
      // Imported bodies skip the face merge (hang guard); see booleanWithDiff.
      const unifyOpts = { unifyFaces: !existingBody.imported }
      try {
        const probe = new DisposeScope()
        try {
          const { shape: inter } = booleanWithDiff(oc, probe, oldShape, toolShape, 'common', unifyOpts)
          if (volumeOf(oc, probe, inter) < 1e-10) continue
        } finally {
          probe.dispose()
        }
      } catch {
        // A failed probe is not evidence of disjointness: skipping here reported
        // "does not intersect" for cuts that would succeed. Fall through to the
        // real cut and let its own failure surface instead.
      }

      const { shape: newShape, diff, faceOrigin } = booleanWithDiff(oc, scope, oldShape, toolShape, 'cut', unifyOpts)
      scope.track(newShape)
      const names = transferBooleanNames(oc, scope, {
        bodyShape: newShape,
        faceOrigin,
        targetFaceNames: existingBody.face_names ?? {},
        targetFaceAncestry: existingBody.face_ancestry ?? {},
        toolFaceNames: faceNames,
        toolFaceAncestry: faceAncestry,
        // The tool is a transient shape, not a body that survives with these names.
        keptToolFeatureId: null,
      })
      existingBody.modified_by.push(featureId)
      existingBody.brep_diff = diff
      existingBody.face_names = names.face_names
      existingBody.edge_names = names.edge_names
      existingBody.face_ancestry = names.face_ancestry
      existingBody.edge_ancestry = names.edge_ancestry

      cutAnything = true
      if (cutBodyId === null) cutBodyId = bid

      // A cut is the classic disconnector, and the sibling bodies inherit the
      // names just transferred onto `newShape`, narrowed to the faces each one
      // actually owns.
      cutBodyIds.push(...resplitBody(oc, scope, table, bodyStore, existingBody, newShape, featureId))
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
    const bodyIds = registerSplitBodies(oc, scope, table, bodyStore, toolShape, {
      id: bodyId, createdBy: featureId, sketchId, profileQueries, ...toolNames,
    })
    result.body_id = bodyIds[0]
    result.body_ids = bodyIds
    result.operation = 'new'
    return result
  }

  // operation === 'add'
  let fused = false
  let fusedBodyId: string | null = null
  let fusedIds: string[] = []
  if (!needNewBody) {
    for (const bid of targetIds) {
      const existingBody = bodyStore[bid]
      if (existingBody.shape === null) continue
      const oldShape = table.get<OccShape>(existingBody.shape)
      let newShape: OccShape
      let diff
      let faceOrigin
      try {
        // Imported bodies skip the face merge (hang guard); see booleanWithDiff.
        const res = booleanWithDiff(oc, scope, oldShape, toolShape, 'fuse', { unifyFaces: !existingBody.imported })
        newShape = res.shape
        diff = res.diff
        faceOrigin = res.faceOrigin
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
      const names = transferBooleanNames(oc, scope, {
        bodyShape: newShape,
        faceOrigin,
        targetFaceNames: existingBody.face_names ?? {},
        targetFaceAncestry: existingBody.face_ancestry ?? {},
        toolFaceNames: faceNames,
        toolFaceAncestry: faceAncestry,
        // The tool is a transient shape, not a body that survives with these names.
        keptToolFeatureId: null,
      })
      existingBody.face_names = names.face_names
      existingBody.edge_names = names.edge_names
      existingBody.face_ancestry = names.face_ancestry
      existingBody.edge_ancestry = names.edge_ancestry
      // The connectivity guards above make a disjoint fuse unreachable here, so
      // this normally re-seats the body on one solid. It still goes through
      // resplitBody so the guards are the only thing that has to stay right.
      fusedIds = resplitBody(oc, scope, table, bodyStore, existingBody, newShape, featureId)
      existingBody.modified_by.push(featureId)
      existingBody.brep_diff = diff
      fused = true
      fusedBodyId = bid
      break
    }
  }

  if (fused) {
    result.body_id = fusedBodyId as string
    result.body_ids = fusedIds
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
  const bodyIds = registerSplitBodies(oc, scope, table, bodyStore, toolShape, {
    id: bodyId, createdBy: featureId, sketchId, profileQueries, ...toolNames,
  })
  result.body_id = bodyIds[0]
  result.body_ids = bodyIds
  result.operation = 'add'
  return result
}
