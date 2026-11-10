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

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape } from '../occ/occTypes'
import type { Body } from '../types3d'
import type { HandleTable } from '../occ/handleTable'
import { resolveMergeTargets } from './shared/bodyResolution'
import { brepDiffIsEmpty } from './shared/brepDiff'
import { booleanWithDiff, countSolids, shapesIntersect, volumeOf } from '../occ/booleans'
import { nearCoaxialCylinderWarning } from '../occ/nearCoaxial'
import { transferBooleanNames } from './booleanLineage'
import { registerSplitBodies, resplitBody, solidHoldingFaces } from './bodySplit'
import { readBodyNames } from '../occ/bodyNames'
import type { SubShapeMap } from '../occ/subshapeIdentity'
import { swallowUnlessTrap } from '../errors'

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
  faceNames?: SubShapeMap<string> | null
  edgeNames?: SubShapeMap<string> | null
  faceAncestry?: Record<string, string[]> | null
  edgeAncestry?: Record<string, string[]> | null
  capAncestry?: Record<string, string[]> | null
  // Per-uuid creators the tool body already has (a pattern copy's UUIDs belong
  // to the pattern). Carried through the transfer so a body's owner maps keep
  // every earlier application's attribution.
  faceOwner?: Record<string, string> | null
  edgeOwner?: Record<string, string> | null
  // A cut that misses every target probes this before it fails: the same tool
  // built the opposite way. When it would remove material the error names the
  // one-field fix (`message`) instead of only "nothing to remove". A face
  // sketch's normal points out of the body, so this is the common miss.
  oppositeProbe?: { tool: () => OccShape | null; message: string }
  // An add is material added to an existing body, so a leaf that sets this
  // refuses to mint a body when its tool reaches none. Without it an add is the
  // general "make material" operation (revolve, sweep) and mints its own
  // body, which extrude no longer wants: an extrude that joins nothing is a
  // silently misplaced profile, not a new part.
  addRequiresExisting?: boolean
}

export interface ApplyBodyOperationResult {
  status: string
  body_id: string
  operation?: string
  body_ids?: string[]
  solver_warning?: string
}

/**
 * Refuse a shape whose shell orientation makes it integrate to a negative
 * volume. A body's material is signed by its outer shell, so a reversed shell
 * reads as negative material everywhere downstream even though BRepCheck can
 * call the topology valid. The nested-loop extrude once registered such a body
 * (V_outer - 2 * V_inner = -9927) and later features silently changed nothing;
 * this turns any repeat of that class into a red feature naming the shape.
 */
function assertPositiveVolume(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  what: string,
  opName: string,
): void {
  const volume = volumeOf(oc, scope, shape)
  if (volume < -NEGATIVE_VOLUME_EPS) {
    throw new Error(
      `${opName}: ${what} has a negative volume (${volume.toFixed(6)}); a shell is inside out`,
    )
  }
}

// Rounding on a sliver can make a near-zero volume read a hair negative; only a
// sign that survives that noise is a reversed shell.
const NEGATIVE_VOLUME_EPS = 1e-9

/**
 * The error an `add` that must extend existing material raises. The two texts
 * separate the two causes a user can see: no body at all in the document, and a
 * profile placed beside the part. Both name the one-field fix, because the
 * geometry the caller would otherwise get -- a new body nobody asked for -- is
 * exactly what the warning used to paper over.
 */
function addWithNothingMessage(opName: string, hadBodies: boolean): string {
  return hadBodies
    ? `${opName}: add does not merge with any existing body (the profile shares no volume with one); ` +
        'move it onto the part, or use operation: new to create a body'
    : `${opName}: add has no existing body to extend; use operation: new to create one`
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
    capAncestry = null,
    faceOwner = null,
    edgeOwner = null,
    oppositeProbe,
    addRequiresExisting = false,
  } = input

  // The tool body's construction-name maps, carried onto a body the tool becomes
  // (the "new"/no-target paths) and narrowed per sibling when it splits. Boolean
  // paths (add/cut) rebuild them in Stage 2.
  const toolNames = { faceNames, edgeNames, faceAncestry, edgeAncestry, capAncestry, faceOwner, edgeOwner }

  const result: ApplyBodyOperationResult = { status: 'ok', body_id: bodyId }

  // The tool is checked lazily: the OCC-free early branches (a cut with no
  // target, an unresolvable merge target) never touch either handle, and the
  // their unit tests pin that. The first branch that is about to turn the tool
  // into material or feed it to a boolean causes the check.
  let toolVolumeChecked = false
  const requireToolVolume = (): void => {
    if (toolVolumeChecked) return
    toolVolumeChecked = true
    assertPositiveVolume(oc, scope, toolShape, 'the tool solid', opName)
  }

  let needNewBody = false
  let targetIds: string[] = []
  if (operation === 'add' || operation === 'cut') {
    targetIds = resolveMergeTargets(mergeTarget, bodyStore, opName)
    if (!targetIds.length && !mergeTarget && operation === 'add') {
      if (addRequiresExisting) throw new Error(addWithNothingMessage(opName, false))
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
    }
  }

  if (operation === 'cut') {
    let cutAnything = false
    let cutBodyId: string | null = null
    const cutBodyIds: string[] = []
    const consumedBodyIds: string[] = []
    for (const bid of targetIds) {
      const existingBody = bodyStore[bid]
      if (existingBody.shape === null) continue
      const oldShape = table.get<OccShape>(existingBody.shape)
      // Skip targets the tool does not actually intersect. A bare Common probe
      // with history off; the verdict is a solid count, not a volume, so an
      // open-shelled imported body is not read as disjoint (L5). A failed probe
      // returns true, so nothing here can skip on a throw.
      if (!shapesIntersect(oc, oldShape, toolShape)) continue

      const unifyOpts = { unifyFaces: !existingBody.imported }
      requireToolVolume()
      const { shape: newShape, diff, faceOrigin } = booleanWithDiff(oc, scope, oldShape, toolShape, 'cut', unifyOpts)
      scope.track(newShape)
      assertPositiveVolume(oc, scope, newShape, 'the cut result', opName)

      // If the cut consumed the entire body, remove it rather than registering
      // an empty compound.  Mirrors the auto-deletion in `solveDeleteBody`
      // (`deleteBody.ts`).
      if (countSolids(oc, scope, newShape) === 0) {
        // The owner tag is settled with the body, so a later `releaseOwner`
        // cannot over-decrement (see releaseFor).
        if (existingBody.shape !== null) {
          table.releaseFor(existingBody.shape, existingBody.modified_by.at(-1) ?? existingBody.created_by)
        }
        delete bodyStore[bid]
        cutAnything = true
        consumedBodyIds.push(bid)
        continue
      }

      const targetNames = readBodyNames(oc, scope, oldShape, existingBody)
      const names = transferBooleanNames(oc, scope, {
        bodyShape: newShape,
        faceOrigin,
        targetFaceNames: targetNames.faceNames,
        targetFaceAncestry: existingBody.face_ancestry ?? {},
        targetCapAncestry: existingBody.face_cap_ancestry ?? {},
        targetFaceOwner: targetNames.faceOwner,
        targetEdgeOwner: targetNames.edgeOwner,
        toolFaceNames: faceNames,
        toolFaceAncestry: faceAncestry,
        toolCapAncestry: capAncestry,
        toolFaceOwner: faceOwner,
        toolEdgeOwner: edgeOwner,
        toolCreatedBy: featureId,
        // The tool shape itself is transient, but with no `merge_target` a cut
        // reaches EVERY body, and each one it hits inherits the same tool face
        // names. The first body cut keeps them verbatim -- so a single-target
        // cut, which is nearly all of them, names its walls as it always has --
        // and every further body scopes its copy to itself.
        toolUuidScope: cutAnything ? bid : null,
      })
      existingBody.modified_by.push(featureId)
      existingBody.brep_diff = diff

      cutAnything = true
      if (cutBodyId === null) cutBodyId = bid

      // A cut is the classic disconnector, and the sibling bodies inherit the
      // names just transferred onto `newShape`, narrowed to the faces each one
      // actually owns.
      cutBodyIds.push(...resplitBody(oc, scope, table, bodyStore, existingBody, newShape, featureId, names))
    }
    if (!cutAnything) {
      const flipped = oppositeProbe?.tool() ?? null
      if (flipped !== null) {
        const reaches = targetIds.some((bid) => {
          const handle = bodyStore[bid]?.shape
          return handle != null && shapesIntersect(oc, table.get<OccShape>(handle), flipped)
        })
        scope.release(flipped)
        if (reaches) throw new Error(`${opName}: ${oppositeProbe!.message}`)
      }
      throw new Error(`${opName}: cut does not intersect any target body - nothing to remove`)
    }
    // A merge-target cut that consumes the target never mints `bodyId`, so
    // body_id keeps that would-be id; hole and array instead keep the consumed
    // body's real id. body_ids is empty either way.
    result.body_id = cutBodyId ?? bodyId
    result.body_ids = cutBodyIds
    result.operation = 'cut'
    const cutBody = cutBodyId !== null ? bodyStore[cutBodyId] : undefined
    if (cutBody && brepDiffIsEmpty(cutBody.brep_diff)) {
      result.solver_warning = `${opName}: operation produced no geometry change`
    }
    if (consumedBodyIds.length > 0) {
      // The bodies are gone, so body_ids must not name them. This is the same
      // deletion event hole and array report, with the same wording.
      const deleted = consumedBodyIds
        .map((id) => `${opName}: the cut removed all of body '${id}'; the body was deleted`)
        .join('; ')
      result.solver_warning = result.solver_warning === undefined
        ? deleted
        : `${result.solver_warning}; ${deleted}`
    }
    return result
  }

  if (operation === 'new') {
    requireToolVolume()
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
  // Read on the fused shell, where the two faces the boolean kept still exist.
  let nearCoaxial: string | null = null
  if (!needNewBody) {
    for (const bid of targetIds) {
      const existingBody = bodyStore[bid]
      if (existingBody.shape === null) continue
      const oldShape = table.get<OccShape>(existingBody.shape)
      let newShape: OccShape
      let diff
      let faceOrigin
      try {
        requireToolVolume()
        // Imported bodies skip the face merge (hang guard); see booleanWithDiff.
        const res = booleanWithDiff(oc, scope, oldShape, toolShape, 'fuse', { unifyFaces: !existingBody.imported })
        newShape = res.shape
        diff = res.diff
        faceOrigin = res.faceOrigin
      } catch (exc) {
        swallowUnlessTrap(exc)
        throw new Error(`${opName}: add operation failed: ${String(exc)}`)
      }
      scope.track(newShape)
      assertPositiveVolume(oc, scope, newShape, 'the fused result', opName)
      nearCoaxial = nearCoaxialCylinderWarning(oc, scope, newShape)
      // An explicit target asks for a fuse, but a copy that does not touch it is
      // a separate part, a regular outcome. Let resplitBody mint the island as
      // its own body and keep the target id on the target material, identified
      // by the faces the boolean carried over from the target.
      let preferredFirst: OccShape | null = null
      if (mergeTarget) {
        const targetFaces = faceOrigin
          .filter((origin) => !origin.fromTool)
          .map((origin) => origin.output as OccShape)
        preferredFirst = solidHoldingFaces(oc, scope, newShape, targetFaces)
      } else {
        // Default add (no explicit target): only fuse with a body the new solid
        // actually connects to. If the union stays disjoint (solid count does
        // not drop), the profile is a separate part; skip and let it be its own.
        const oldN = countSolids(oc, scope, oldShape)
        const toolN = countSolids(oc, scope, toolShape)
        if (countSolids(oc, scope, newShape) >= oldN + toolN) continue
      }
      const targetNames = readBodyNames(oc, scope, oldShape, existingBody)
      const names = transferBooleanNames(oc, scope, {
        bodyShape: newShape,
        faceOrigin,
        targetFaceNames: targetNames.faceNames,
        targetFaceAncestry: existingBody.face_ancestry ?? {},
        targetCapAncestry: existingBody.face_cap_ancestry ?? {},
        targetFaceOwner: targetNames.faceOwner,
        targetEdgeOwner: targetNames.edgeOwner,
        toolFaceNames: faceNames,
        toolFaceAncestry: faceAncestry,
        toolCapAncestry: capAncestry,
        toolFaceOwner: faceOwner,
        toolEdgeOwner: edgeOwner,
        toolCreatedBy: featureId,
        // A fuse lands on exactly one target (the loop breaks below), and the
        // tool shape is transient, so nothing else claims these names.
        toolUuidScope: null,
      })
      // A default add reaches here only when the fuse connected, while an
      // explicit merge target may leave an island. resplitBody hands the target
      // material the existing id through preferredFirst and mints the island as
      // a sibling.
      fusedIds = resplitBody(oc, scope, table, bodyStore, existingBody, newShape, featureId, names, preferredFirst)
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
    if (nearCoaxial !== null) {
      result.solver_warning = result.solver_warning === undefined
        ? nearCoaxial
        : `${result.solver_warning}; ${nearCoaxial}`
    }
    return result
  }
  if (mergeTarget) {
    throw new Error(`${opName}: add could not fuse with any target body`)
  }
  if (addRequiresExisting) throw new Error(addWithNothingMessage(opName, true))
  // No target body: the tool becomes its own body (one per solid).
  requireToolVolume()
  const bodyIds = registerSplitBodies(oc, scope, table, bodyStore, toolShape, {
    id: bodyId, createdBy: featureId, sketchId, profileQueries, ...toolNames,
  })
  result.body_id = bodyIds[0]
  result.body_ids = bodyIds
  result.operation = 'add'
  return result
}
