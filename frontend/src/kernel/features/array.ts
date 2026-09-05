// The linear/rectangular array and circular array leaves. Both build a list of gp_Trsf instance
// transforms, copy the source body through each, and either fuse the copies into the source
// (operation "add") or spawn one new body per copy (operation "new"). Shared
// instance-application logic lives in `applyArray`.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape, OccTrsf } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body, BrepDiff } from '../types3d'
import type { Repository } from '../query'
import { resolveBody, AmbiguousBodyRefError, resolveDirectionQueryStrict, resolveAxisQueryStrict } from './shared'
import { makeTranslationTrsf, makeRotationTrsf } from '../occ/transforms'
import { booleanWithDiff } from '../occ/booleans'
import { transformCopyWithMapping, rebuildNamesForTransformedCopy, readSourceFaceRows, type NameMaps } from '../occ/transformLineage'
import { transferBooleanNames } from './booleanLineage'
import { registerSplitBodies, resplitBody } from './bodySplit'

type Dict = Record<string, unknown>

interface ArrayResult {
  status: string
  // The first body; `body_ids` carries the rest when instances or splits add more.
  body_id: string
  body_ids: string[]
  operation: string
  solver_warning?: string
}

/**
 * Resolve a required array direction from its picker query, applying the
 * per-axis invert toggle. The direction must come from a picked straight edge
 * or planar face: an empty or dangling query is a solve error rather than a
 * silent world-axis fallback, so the user cannot accidentally array a body
 * along an arbitrary direction.
 */
function resolveArrayDirection(
  feature: Dict,
  axis: 'x' | 'y',
  globalRepo: Repository,
  bodyStore: Record<string, unknown> | null,
): number[] {
  const label = axis.toUpperCase()
  const query = (feature[`direction_${axis}_query`] as string) ?? ''
  if (!query) throw new Error(`array: direction ${label} is required; pick a straight edge or planar face`)
  const dir = resolveDirectionQueryStrict(query, globalRepo, bodyStore)
  if (!dir) {
    throw new Error(`array: direction ${label} query '${query}' did not resolve to a straight edge or planar face`)
  }
  const invert = (feature[`invert_${axis}`] as boolean) ?? false
  // `c === 0 ? 0 : -c` keeps the negated zero components as +0, not -0.
  return invert ? dir.map((c) => (c === 0 ? 0 : -c)) : dir
}

/** Build linear/rectangular array instance transforms (mirrors `_build_array_transforms`). */
export function buildArrayTransforms(
  oc: OccModule,
  scope: DisposeScope,
  feature: Dict,
  globalRepo: Repository,
  bodyStore: Record<string, unknown> | null = null,
): OccTrsf[] {
  const mode = (feature.mode as string) ?? 'linear'
  const includeSource = (feature.include_source as boolean) ?? true
  const trsfs: OccTrsf[] = []

  if (mode === 'linear') {
    // Number.isInteger rejects NaN, Infinity, and fractional values in one check,
    // so a hand-edited or expression-derived 2.7 throws instead of silently
    // truncating to 2.
    const countX = Number(feature.count_x ?? 2)
    if (!Number.isInteger(countX) || countX < 1) {
      throw new Error(`array: count_x must be a positive integer, got ${feature.count_x}`)
    }
    const pitchX = Number(feature.pitch_x ?? 10.0)
    if (!Number.isFinite(pitchX)) throw new Error(`array: pitch_x must be a finite number, got ${feature.pitch_x}`)
    const dirX = resolveArrayDirection(feature, 'x', globalRepo, bodyStore)
    const num = includeSource ? countX - 1 : countX
    for (let i = 1; i <= num; i++) {
      trsfs.push(makeTranslationTrsf(oc, scope, dirX[0] * pitchX * i, dirX[1] * pitchX * i, dirX[2] * pitchX * i))
    }
  } else if (mode === 'rectangular') {
    const countX = Number(feature.count_x ?? 2)
    if (!Number.isInteger(countX) || countX < 1) {
      throw new Error(`array: count_x must be a positive integer, got ${feature.count_x}`)
    }
    const countY = Number(feature.count_y ?? 2)
    if (!Number.isInteger(countY) || countY < 1) {
      throw new Error(`array: count_y must be a positive integer, got ${feature.count_y}`)
    }
    const pitchX = Number(feature.pitch_x ?? 10.0)
    if (!Number.isFinite(pitchX)) throw new Error(`array: pitch_x must be a finite number, got ${feature.pitch_x}`)
    const pitchY = Number(feature.pitch_y ?? 10.0)
    if (!Number.isFinite(pitchY)) throw new Error(`array: pitch_y must be a finite number, got ${feature.pitch_y}`)
    const dirX = resolveArrayDirection(feature, 'x', globalRepo, bodyStore)
    const dirY = resolveArrayDirection(feature, 'y', globalRepo, bodyStore)
    for (let j = 0; j < countY; j++) {
      for (let i = 0; i < countX; i++) {
        if (includeSource && i === 0 && j === 0) continue
        trsfs.push(
          makeTranslationTrsf(
            oc,
            scope,
            dirX[0] * pitchX * i + dirY[0] * pitchY * j,
            dirX[1] * pitchX * i + dirY[1] * pitchY * j,
            dirX[2] * pitchX * i + dirY[2] * pitchY * j,
          ),
        )
      }
    }
  } else {
    throw new Error(`array: unknown mode '${mode}'`)
  }
  return trsfs
}

/** Build circular array instance transforms (mirrors `_build_circular_transforms`). */
export function buildCircularTransforms(
  oc: OccModule,
  scope: DisposeScope,
  feature: Dict,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
): OccTrsf[] {
  const count = Number(feature.count ?? 4)
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`circular_array: count must be a positive integer, got ${feature.count}`)
  }
  const includeSource = (feature.include_source as boolean) ?? true
  const stepRaw = feature.step_angle
  const step = stepRaw === undefined || stepRaw === null ? 360.0 / count : Number(stepRaw)
  if (!Number.isFinite(step)) {
    throw new Error(`circular_array: step_angle must be a finite number, got ${feature.step_angle}`)
  }
  // The rotation axis can be a straight edge, circular edge, sketch line,
  // sketch circle, cylindrical face, or planar face; an empty or dangling pick
  // is a solve error rather than a silent rotation about world Z.
  const axisQuery = (feature.axis as string) ?? ''
  if (!axisQuery) throw new Error('circular_array: axis is required; pick an edge, sketch entity, or face')
  const axis = resolveAxisQueryStrict(axisQuery, globalRepo, bodyStore)
  if (!axis) {
    throw new Error(`circular_array: axis query '${axisQuery}' did not resolve to a usable axis`)
  }
  const [axisOrigin, resolvedDirection] = axis
  // Invert flips the axis direction, which reverses the sweep sense.
  const invert = (feature.invert_axis as boolean) ?? false
  const axisDirection = invert ? resolvedDirection.map((c) => (c === 0 ? 0 : -c)) : resolvedDirection
  const trsfs: OccTrsf[] = []
  if (includeSource) {
    // Source occupies the seed (0-degree) slot; sweep from step.
    for (let i = 1; i < count; i++) {
      trsfs.push(makeRotationTrsf(oc, scope, axisOrigin, axisDirection, ((step * i) * Math.PI) / 180))
    }
  } else {
    // No source slot; sweep from the seed angle, stopping before the
    // full-360 wrap that would place the last copy on the source position.
    const n = (step !== 0 && Math.abs((step * count) % 360) < 1e-9) ? count - 1 : count
    for (let i = 0; i < n; i++) {
      trsfs.push(makeRotationTrsf(oc, scope, axisOrigin, axisDirection, ((step * i) * Math.PI) / 180))
    }
  }
  return trsfs
}

/** Shared instance build + fuse/new dispatch for both array leaves. */
function applyArray(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  body: Body,
  transforms: OccTrsf[],
  includeSource: boolean,
  operation: string,
  featureId: string,
  bodyStore: Record<string, Body>,
  opLabel: string,
): ArrayResult {
  // resolveSourceBody already guards this on both public entry points, but the
  // assertion is kept here too so applyArray fails loud on its own, matching
  // the fail-loud idiom the rest of this directory uses for required fields.
  if (body.shape === null) throw new Error(`${opLabel}: source body has no shape`)
  const sourceShape = table.get<OccShape>(body.shape)
  const sourceNames: NameMaps = {
    faceNames: body.face_names ?? {},
    faceAncestry: body.face_ancestry ?? {},
    edgeNames: body.edge_names ?? {},
    edgeAncestry: body.edge_ancestry ?? {},
  }

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
    // (M37 Change 2a). The count_x=1 no-op below never reads them.
    const rows = transforms.length > 0
      ? readSourceFaceRows(oc, scope, sourceShape, sourceNames.faceNames, sourceNames.faceAncestry)
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
      // count_x=1 with include_source: no transformed instances, and the source
      // IS the array. A no-op, not an error -- mirror the add path's early
      // return below so toggling include_source on a 1-count new array does not
      // throw.
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
  const instances: OccShape[] = []
  const instanceNames: NameMaps[] = []
  if (includeSource) {
    instances.push(sourceShape)
    instanceNames.push(sourceNames)
  }
  // Same one-read-per-instance-loop hoist as the new branch: the source rows
  // are identical for every instance (M37 Change 2a).
  const rows = readSourceFaceRows(oc, scope, sourceShape, sourceNames.faceNames, sourceNames.faceAncestry)
  for (let i = 0; i < transforms.length; i++) {
    const idx = includeSource ? i + 1 : i
    const { shape: instShape, builder } = transformCopyWithMapping(oc, scope, sourceShape, transforms[i])
    const shape = scope.track(instShape)
    instances.push(shape)
    instanceNames.push(rebuildNamesForTransformedCopy(oc, scope, shape, rows, featureId, idx, builder))
  }
  if (instances.length === 0) throw new Error(`${opLabel} produced no instances`)

  let fused = instances[0]
  let fusedNames = instanceNames[0]
  let lastDiff: BrepDiff | null = null
  for (let i = 1; i < instances.length; i++) {
    const prev = fused
    const r = booleanWithDiff(oc, scope, fused, instances[i], 'fuse', { unifyFaces: !body.imported })
    fused = scope.track(r.shape)
    const names = transferBooleanNames(oc, scope, {
      bodyShape: fused,
      faceOrigin: r.faceOrigin,
      targetFaceNames: fusedNames.faceNames,
      targetFaceAncestry: fusedNames.faceAncestry,
      toolFaceNames: instanceNames[i].faceNames,
      toolFaceAncestry: instanceNames[i].faceAncestry,
      // Each instance was already remapped to its own UUIDs by
      // `rebuildNamesForTransformedCopy`, so nothing collides.
      toolUuidScope: null,
    })
    fusedNames = {
      faceNames: names.face_names,
      faceAncestry: names.face_ancestry,
      edgeNames: names.edge_names,
      edgeAncestry: names.edge_ancestry,
    }
    lastDiff = r.diff
    // Release ONLY here, never above. `r.faceOrigin`'s `source` entries are
    // sub-shapes OF THE OPERANDS, and transferBooleanNames downcasts and hashes
    // them (booleanLineage.ts:81-82). Freeing an operand before that line is a
    // use-after-free that reads plausibly and fails nowhere.
    //
    // instances[0] is the HandleTable-owned `sourceShape` when include_source is
    // set (array.ts:180, :238). scope.release() deletes a foreign object it was
    // never tracking (disposeScope.ts:60-70), so releasing it would free the
    // table's shape out from under every later feature.
    const prevIsTableOwned = i === 1 && includeSource
    if (!prevIsTableOwned) scope.release(prev)
    scope.release(instances[i])
    // The releases do not invalidate what survives the loop: body.brep_diff is
    // lastDiff, whose sub-shape handles are independent embind wrappers holding
    // their own refcounted TShape, so deleting an operand wrapper does not free
    // geometry the diff still references (same argument as boolean.ts:115 and
    // extrude.ts:317-320).
  }
  body.modified_by.push(featureId)
  body.brep_diff = lastDiff
  body.face_names = fusedNames.faceNames
  body.face_ancestry = fusedNames.faceAncestry
  body.edge_names = fusedNames.edgeNames
  body.edge_ancestry = fusedNames.edgeAncestry
  // "add" fuses the instances into the source body, but a pitch wider than the
  // part leaves that fuse disjoint: the union of N non-touching copies is an
  // N-solid compound, which is N parts, not one.
  const bodyIds = resplitBody(oc, scope, table, bodyStore, body, fused, featureId)
  if (bodyIds.length === 0) {
    // A union can only be empty through a failed boolean, so this is defensive:
    // resplitBody deleted the body, and body_ids must not hand back a live id
    // for a body that is gone.
    return {
      status: 'ok',
      body_id: body.id,
      body_ids: [],
      operation: 'add',
      solver_warning: `array: the add removed all of body '${body.id}'; the body was deleted`,
    }
  }
  return { status: 'ok', body_id: bodyIds[0], body_ids: bodyIds, operation: 'add' }
}

function resolveSourceBody(
  feature: Dict,
  bodyStore: Record<string, Body>,
  opLabel: string,
): Body {
  const ref = (feature.source_body as string) ?? ''
  // A missing pick is a solve error: without an explicit source body the array
  // has no defined subject. Silently defaulting to the first body in the store
  // hid mis-picks and produced arrays of an arbitrary body (matches the
  // transform/mirror leaves, which also require an explicit body pick).
  if (!ref) throw new Error(`${opLabel}: source body is required; pick a body to array`)
  let body: Body
  try {
    body = resolveBody(ref, bodyStore)
  } catch (e) {
    // "Names several bodies" is not "does not exist": rewriting it would tell
    // the user the body is missing while listing the ids that matched it.
    if (e instanceof AmbiguousBodyRefError) throw e
    throw new Error(`${opLabel}: source body '${ref}' not found; available body IDs: ${JSON.stringify(Object.keys(bodyStore))}`)
  }
  if (body.shape === null) throw new Error(`${opLabel}: source body has no shape`)
  return body
}

/**
 * Solve a linear/rectangular array (mirrors `_solve_array`).
 *
 * `include_source` with `operation: 'new'` means the source body stands as
 * instance 0; only the transformed instances become new bodies.
 */
export function solveArray(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
): ArrayResult {
  const featureId = (feature.id as string) ?? ''
  const sub = (feature.array as Dict) ?? {}
  const merged: Dict = { ...sub, ...feature }
  const body = resolveSourceBody(merged, bodyStore, 'array')
  const includeSource = (merged.include_source as boolean) ?? true
  const operation = (merged.operation as string) ?? 'add'
  const transforms = buildArrayTransforms(oc, scope, merged, globalRepo, bodyStore)
  return applyArray(oc, scope, table, body, transforms, includeSource, operation, featureId, bodyStore, 'array')
}

/** Solve a circular array (mirrors `_solve_circular_array`). */
export function solveCircularArray(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
): ArrayResult {
  const featureId = (feature.id as string) ?? ''
  const sub = (feature.circular_array as Dict) ?? {}
  const merged: Dict = { ...sub, ...feature }
  const body = resolveSourceBody(merged, bodyStore, 'circular_array')
  const includeSource = (merged.include_source as boolean) ?? true
  const operation = (merged.operation as string) ?? 'add'
  const transforms = buildCircularTransforms(oc, scope, merged, globalRepo, bodyStore)
  return applyArray(oc, scope, table, body, transforms, includeSource, operation, featureId, bodyStore, 'circular_array')
}
