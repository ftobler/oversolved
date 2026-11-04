// The body subject of a pattern: copy a whole body through a list of instance
// transforms and either fuse the copies into the source (operation "add") or
// spawn one new body per copy (operation "new"). The feature subject lives in
// pattern.ts; both share the transforms pattern.ts builds and the one feature
// kind, so a document selects the subject instead of a separate array feature.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape, OccSubShape, OccTrsf } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body, BrepDiff } from '../types3d'
import { resolveBody, AmbiguousBodyRefError } from './shared/bodyResolution'
import { booleanWithDiffMany } from '../occ/booleans'
import { transformCopyWithMapping, rebuildNamesForTransformedCopy, readSourceFaceRows, type NameMaps } from '../occ/transformLineage'
import { transferBooleanNames } from './booleanLineage'
import { registerSplitBodies, resplitBody, solidHoldingFaces } from './bodySplit'
import { emptyShapeNames, mergeShapeNames, readBodyNames } from '../occ/bodyNames'
import { markFeatureStart } from '../featureProgress'
import { SubShapeDedup } from '../occ/primitives'

type Dict = Record<string, unknown>

/** How many copies one fuse takes. Chunking bounds the live instance shapes: a
 *  count in the thousands would otherwise hold every transformed copy at once,
 *  and the release contract (arrayFuseRelease.test.ts) pins this peak. */
export const INSTANCE_FUSE_CHUNK = 16

export interface BodyPatternResult {
  [key: string]: unknown
  status: string
  // The first body; `body_ids` carries the rest when instances or splits add more.
  body_id: string
  body_ids: string[]
  operation: string
  solver_warning?: string
}

/** The body a body-subject pattern copies. An explicit pick is required: a
 *  default would silently pattern an arbitrary body in the store. */
export function resolvePatternSourceBody(
  sub: Dict,
  bodyStore: Record<string, Body>,
): Body {
  const ref = (sub.source_body as string) ?? ''
  if (!ref) throw new Error('pattern: source body is required; pick a body to pattern')
  let body: Body
  try {
    body = resolveBody(ref, bodyStore)
  } catch (e) {
    // "Names several bodies" is not "does not exist": rewriting it would tell
    // the user the body is missing while listing the ids that matched it.
    if (e instanceof AmbiguousBodyRefError) throw e
    throw new Error(`pattern: source body '${ref}' not found; available body IDs: ${JSON.stringify(Object.keys(bodyStore))}`)
  }
  if (body.shape === null) throw new Error('pattern: source body has no shape')
  return body
}

/** Shared instance build + fuse/new dispatch for a body pattern. */
export function applyBodyPattern(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  body: Body,
  transforms: OccTrsf[],
  includeSource: boolean,
  operation: string,
  featureId: string,
  bodyStore: Record<string, Body>,
): BodyPatternResult {
  if (body.shape === null) throw new Error('pattern: source body has no shape')
  const sourceShape = table.get<OccShape>(body.shape)
  // Read on first use: the no-op returns below must not touch the shape.
  let sourceNamesRead: NameMaps | null = null
  const sourceNames = (): NameMaps => (sourceNamesRead ??= readBodyNames(oc, scope, sourceShape, body))

  const resultBodyId = 'body_' + featureId

  if (operation === 'new') {
    // Every spawned body is an independent copy; remap construction UUIDs so
    // identical instances do not collide.
    const instances: { shape: OccShape; names: NameMaps }[] = []
    // `include_source` needs no instance here: with operation 'new' the SOURCE
    // BODY is instance 0. Copying it produced a second body coincident with the
    // first -- two Parts rows for one visible solid. The transforms below are
    // still numbered from 1 when include_source is set, so instance UUIDs keep
    // their meaning across an edit that toggles the flag.
    // The source rows are identical for every instance, so they are read once
    // above the instance loop instead of re-explored and re-hashed per copy
    // (M37 Change 2a). The count=1 no-op below never reads them.
    const rows = transforms.length > 0
      ? readSourceFaceRows(oc, scope, sourceShape, sourceNames().faceNames, sourceNames().faceAncestry)
      : []
    for (let i = 0; i < transforms.length; i++) {
      const idx = includeSource ? i + 1 : i
      const { shape: instShape, builder } = transformCopyWithMapping(oc, scope, sourceShape, transforms[i])
      const shape = scope.track(instShape)
      instances.push({
        shape,
        names: rebuildNamesForTransformedCopy(oc, scope, shape, rows, featureId, idx, builder),
      })
    }
    if (instances.length === 0) {
      // A one-instance pattern with include_source: no transformed instances,
      // and the source IS the pattern. A no-op, not an error -- mirror the add
      // path's early return below so toggling include_source on a 1-count new
      // pattern does not throw.
      return { status: 'ok', body_id: body.id, body_ids: [body.id], operation: 'new' }
    }
    // One instance is normally one solid, so this normally mints exactly the
    // old `body_<feat>`, `body_<feat>_1`, ... run. Going through bodySplit is
    // what keeps that true when the source body is itself multi-solid: the
    // instances would otherwise each copy the violation verbatim.
    const bodyIds: string[] = []
    for (const inst of instances) {
      bodyIds.push(...registerSplitBodies(oc, scope, table, bodyStore, inst.shape, {
        id: resultBodyId, createdBy: featureId, profileQueries: body.profile_queries, ...inst.names,
      }))
    }
    return { status: 'ok', body_id: bodyIds[0], body_ids: bodyIds, operation: 'new' }
  }

  // operation === "add": fuse incrementally and rebuild construction names
  // after each union. The source instance keeps its original UUIDs; copied
  // instances get instance-specific UUIDs so the fused body has no collisions.
  if (includeSource && transforms.length === 0) {
    // include_source with zero instance transforms copies nothing: mutating
    // modified_by or nulling brep_diff here faked a geometry change (spurious
    // dirty signal) and destroyed the previous op's diff. Leave the body as-is.
    return { status: 'ok', body_id: body.id, body_ids: [body.id], operation: 'add' }
  }
  // Same one-read-per-instance-loop hoist as the new branch: the source rows
  // are identical for every instance (M37 Change 2a).
  const rows = readSourceFaceRows(oc, scope, sourceShape, sourceNames().faceNames, sourceNames().faceAncestry)
  const buildCopy = (i: number): { shape: OccShape; names: NameMaps } => {
    const idx = includeSource ? i + 1 : i
    const { shape: instShape, builder } = transformCopyWithMapping(oc, scope, sourceShape, transforms[i])
    const shape = scope.track(instShape)
    return { shape, names: rebuildNamesForTransformedCopy(oc, scope, shape, rows, featureId, idx, builder) }
  }

  // The source instance keeps its original UUIDs; copied instances get
  // instance-specific UUIDs so the fused body has no collisions.
  let fused: OccShape
  let fusedNames: NameMaps
  let firstCopy: number
  if (includeSource) {
    fused = sourceShape
    fusedNames = sourceNames()
    firstCopy = 0
  } else {
    if (transforms.length === 0) throw new Error('pattern produced no instances')
    // No source slot: the first transformed copy is the fuse seed and replaces
    // the body, exactly as this branch did before the batch.
    const first = buildCopy(0)
    fused = first.shape
    fusedNames = first.names
    firstCopy = 1
  }
  let lastDiff: BrepDiff | null = null
  // The source body's own faces, tracked through every union by the boolean's
  // face origin. Whole-solid IsSame does not survive the clean pass on a
  // multi-face body (measured: a fused rail loses it on the first disjoint
  // union), while the face lineage does; a solid is then identified by any of
  // its own faces. Without this the split ranked siblings by centroid and gave
  // the source's id to a copy.
  let sourceFaces: OccShape[] = []
  // Chunk the copies into one boolean each. One fuse per copy grew the target
  // quadratically; one fuse for thousands of copies would hold every instance
  // at once. The chunk is built immediately before its boolean and released
  // after the names transfer, so the live instance peak is the chunk size.
  for (let start = firstCopy; start < transforms.length; start += INSTANCE_FUSE_CHUNK) {
    const end = Math.min(start + INSTANCE_FUSE_CHUNK, transforms.length)
    markFeatureStart(featureId)
    const chunk: OccShape[] = []
    const toolNames = emptyShapeNames()
    for (let i = start; i < end; i++) {
      const copy = buildCopy(i)
      chunk.push(copy.shape)
      mergeShapeNames(toolNames, copy.names)
    }
    const r = booleanWithDiffMany(oc, scope, fused, chunk, 'fuse', { unifyFaces: !body.imported })
    const nextFused = scope.track(r.shape)
    if (includeSource) {
      const next: OccShape[] = []
      const seen = new SubShapeDedup()
      const firstUnion = start === firstCopy
      for (const origin of r.faceOrigin) {
        if (origin.fromTool) continue
        const fromSource = firstUnion
          || sourceFaces.some((sf) => (origin.source as OccSubShape).IsSame(sf as OccSubShape))
        if (fromSource && seen.add(origin.output)) next.push(origin.output as OccShape)
      }
      // An empty set means the history could not narrate the source at all; keep
      // the last usable set rather than turning a naming fallback into a throw.
      if (next.length > 0) sourceFaces = next
    }
    const names = transferBooleanNames(oc, scope, {
      bodyShape: nextFused,
      faceOrigin: r.faceOrigin,
      targetFaceNames: fusedNames.faceNames,
      targetFaceAncestry: fusedNames.faceAncestry,
      targetCapAncestry: fusedNames.capAncestry,
      targetFaceOwner: fusedNames.faceOwner,
      targetEdgeOwner: fusedNames.edgeOwner,
      toolFaceNames: toolNames.faceNames,
      toolFaceAncestry: toolNames.faceAncestry,
      toolCapAncestry: toolNames.capAncestry,
      toolFaceOwner: toolNames.faceOwner,
      toolEdgeOwner: toolNames.edgeOwner,
      toolCreatedBy: featureId,
      // Each instance was already remapped to its own UUIDs by
      // `rebuildNamesForTransformedCopy`, so nothing collides.
      toolUuidScope: null,
    })
    fusedNames = names
    lastDiff = r.diff
    // Release ONLY here, never above. `r.faceOrigin`'s `source` entries are
    // sub-shapes OF THE OPERANDS, and transferBooleanNames downcasts and hashes
    // them. Freeing an operand before that call is a use-after-free that reads
    // plausibly and fails nowhere.
    //
    // The seed is the HandleTable-owned `sourceShape` when include_source is
    // set. `DisposeScope.release()` deletes a foreign object it was never
    // tracking, so releasing it would free the table's shape out from under
    // every later feature.
    const prevIsTableOwned = includeSource && start === firstCopy
    if (!prevIsTableOwned) scope.release(fused)
    for (const shape of chunk) scope.release(shape)
    fused = nextFused
  }
  body.modified_by.push(featureId)
  body.brep_diff = lastDiff
  // "add" fuses the instances into the source body, but a pitch wider than the
  // part leaves that fuse disjoint: the union of N non-touching copies is an
  // N-solid compound, which is N parts, not one. The source's own solid is
  // identified by construction through the tracked face lineage, so the split
  // keeps body.id on that material instead of re-ranking siblings by centroid.
  const bodyIds = resplitBody(
    oc, scope, table, bodyStore, body, fused, featureId, fusedNames,
    solidHoldingFaces(oc, scope, fused, sourceFaces),
  )
  if (bodyIds.length === 0) {
    // A union can only be empty through a failed boolean, so this is defensive:
    // resplitBody deleted the body, and body_ids must not hand back a live id
    // for a body that is gone.
    return {
      status: 'ok',
      body_id: body.id,
      body_ids: [],
      operation: 'add',
      solver_warning: `pattern: the add removed all of body '${body.id}'; the body was deleted`,
    }
  }
  return { status: 'ok', body_id: bodyIds[0], body_ids: bodyIds, operation: 'add' }
}
