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
  operation: string,
  featureId: string,
  bodyStore: Record<string, Body>,
): BodyPatternResult {
  if (body.shape === null) throw new Error('pattern: source body has no shape')
  const sourceShape = table.get<OccShape>(body.shape)
  // Read once: every copy shares the source's names.
  let sourceNamesRead: NameMaps | null = null
  const sourceNames = (): NameMaps => (sourceNamesRead ??= readBodyNames(oc, scope, sourceShape, body))

  const resultBodyId = 'body_' + featureId

  if (operation === 'new') {
    // Every spawned body is an independent copy; remap construction UUIDs so
    // identical instances do not collide.
    const instances: { shape: OccShape; names: NameMaps }[] = []
    // With operation 'new' the SOURCE BODY is instance 0. Copying it produced a
    // second body coincident with the first -- two Parts rows for one visible
    // solid. The transforms below are therefore numbered from 1, so instance
    // UUIDs keep their meaning as the count changes.
    // The source rows are identical for every instance, so they are read once
    // above the instance loop instead of re-explored and re-hashed per copy
    // (M37 Change 2a).
    const rows = readSourceFaceRows(oc, scope, sourceShape, sourceNames().faceNames, sourceNames().faceAncestry)
    for (let i = 0; i < transforms.length; i++) {
      const idx = i + 1
      const { shape: instShape, builder } = transformCopyWithMapping(oc, scope, sourceShape, transforms[i])
      const shape = scope.track(instShape)
      instances.push({
        shape,
        names: rebuildNamesForTransformedCopy(oc, scope, shape, rows, featureId, idx, builder),
      })
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
  // Same one-read-per-instance-loop hoist as the new branch: the source rows
  // are identical for every instance (M37 Change 2a).
  const rows = readSourceFaceRows(oc, scope, sourceShape, sourceNames().faceNames, sourceNames().faceAncestry)
  const buildCopy = (i: number): { shape: OccShape; names: NameMaps } => {
    const idx = i + 1
    const { shape: instShape, builder } = transformCopyWithMapping(oc, scope, sourceShape, transforms[i])
    const shape = scope.track(instShape)
    return { shape, names: rebuildNamesForTransformedCopy(oc, scope, shape, rows, featureId, idx, builder) }
  }

  // The source instance keeps its original UUIDs; copied instances get
  // instance-specific UUIDs so the fused body has no collisions. The source
  // holds instance 0 and every transform is a copy, so the loop starts at 0.
  let fused: OccShape = sourceShape
  let fusedNames: NameMaps = sourceNames()
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
  // at once. On the batch path the chunk is built immediately before its
  // boolean and released after the names transfer, so the live instance peak
  // is the chunk size.
  //
  // Below one full chunk the copies stay on the one-at-a-time path: the chunk
  // is built once, then each copy is fused and released in turn. The batch is
  // a long-pattern optimization; a short array is a handful of cheap fuses,
  // and it is the shape every document built before the batch already has.
  // Its combined history also attributes an overlapping weld to a different
  // input than the sequential fuse, which moved a source face UUID under an
  // upstream resize (fuzz seed 235) and put UnifySameDomain on the
  // coincident-face spin (seed 535) as soon as the fuzz's three-copy arrays
  // switched to the batch.
  const batchCopies = transforms.length >= INSTANCE_FUSE_CHUNK
  for (let start = 0; start < transforms.length; start += INSTANCE_FUSE_CHUNK) {
    const end = Math.min(start + INSTANCE_FUSE_CHUNK, transforms.length)
    // Covers building this chunk's copies; each fuse below marks again.
    markFeatureStart(featureId)
    const chunk: { shape: OccShape; names: NameMaps }[] = []
    for (let i = start; i < end; i++) chunk.push(buildCopy(i))
    const groups = batchCopies ? [chunk] : chunk.map((copy) => [copy])
    for (const [groupIndex, group] of groups.entries()) {
      markFeatureStart(featureId)
      const toolNames = emptyShapeNames()
      for (const copy of group) mergeShapeNames(toolNames, copy.names)
      const r = booleanWithDiffMany(
        oc, scope, fused, group.map((copy) => copy.shape), 'fuse', { unifyFaces: !body.imported },
      )
      const nextFused = scope.track(r.shape)
      const next: OccShape[] = []
      const seen = new SubShapeDedup()
      const firstUnion = start === 0 && groupIndex === 0
      for (const origin of r.faceOrigin) {
        if (origin.fromTool) continue
        const fromSource = firstUnion
          || sourceFaces.some((sf) => (origin.source as OccSubShape).IsSame(sf as OccSubShape))
        if (fromSource && seen.add(origin.output)) next.push(origin.output as OccShape)
      }
      // An empty set means the history could not narrate the source at all; keep
      // the last usable set rather than turning a naming fallback into a throw.
      if (next.length > 0) sourceFaces = next
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
      // The seed is the HandleTable-owned `sourceShape`. `DisposeScope.release()`
      // deletes a foreign object it was never tracking, so releasing it would
      // free the table's shape out from under every later feature.
      const prevIsTableOwned = start === 0 && groupIndex === 0
      if (!prevIsTableOwned) scope.release(fused)
      for (const copy of group) scope.release(copy.shape)
      fused = nextFused
    }
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
