// The linear/rectangular array and circular array leaves. Both build a list of gp_Trsf instance
// transforms, copy the source body through each, and either fuse the copies into the source
// (operation "add") or spawn one new body per copy (operation "new"). Shared
// instance-application logic lives in `applyArray`.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape, OccSubShape, OccTrsf } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body, BrepDiff } from '../types3d'
import type { Repository } from '../query'
import { resolveBody, AmbiguousBodyRefError } from './shared/bodyResolution'
import { resolveDirectionQueryStrict, resolveAxisQueryStrict } from './shared/directionQuery'
import { makeTranslationTrsf, makeRotationTrsf } from '../occ/transforms'
import { booleanWithDiff, exploreSolids } from '../occ/booleans'
import { transformCopyWithMapping, rebuildNamesForTransformedCopy, readSourceFaceRows, type NameMaps } from '../occ/transformLineage'
import { transferBooleanNames } from './booleanLineage'
import { registerSplitBodies, resplitBody } from './bodySplit'
import { canonicalFaces, readBodyNames } from '../occ/bodyNames'
import { SubShapeDedup } from '../occ/primitives'

type Dict = Record<string, unknown>

interface ArrayResult {
  [key: string]: unknown
  status: string
  // The first body; `body_ids` carries the rest when instances or splits add more.
  body_id: string
  body_ids: string[]
  operation: string
  solver_warning?: string
}

/**
 * Resolve a required array direction, applying the per-axis invert toggle. An
 * explicit pick query wins. Without one, a stored `direction_<axis>` vector is
 * honoured as a unit world vector: the schema accepted it but the leaf used to
 * ignore it and report the direction as missing. With neither, the solve fails
 * rather than falling back to a world axis, so the user cannot accidentally
 * array a body along an arbitrary direction.
 */
function resolveArrayDirection(
  feature: Dict,
  axis: 'x' | 'y',
  globalRepo: Repository,
  bodyStore: Record<string, unknown> | null,
): number[] {
  const label = axis.toUpperCase()
  const query = (feature[`direction_${axis}_query`] as string) ?? ''
  let dir: number[]
  if (query) {
    const resolved = resolveDirectionQueryStrict(query, globalRepo, bodyStore)
    if (!resolved) {
      throw new Error(`array: direction ${label} query '${query}' did not resolve to a straight edge or planar face`)
    }
    dir = resolved
  } else {
    const stored = feature[`direction_${axis}`]
    if (stored === undefined || stored === null) {
      throw new Error(`array: direction ${label} is required; pick a straight edge or planar face`)
    }
    if (!Array.isArray(stored) || stored.length !== 3 || !stored.every((c) => typeof c === 'number' && Number.isFinite(c))) {
      throw new Error(`array: direction ${label} must be three finite numbers, got ${JSON.stringify(stored)}`)
    }
    const len = Math.hypot(stored[0], stored[1], stored[2])
    if (len < 1e-12) throw new Error(`array: direction ${label} must be a non-zero vector`)
    dir = (stored as number[]).map((c) => c / len)
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
        // The seed cell (0,0) is the source position, never a copy, whether or
        // not the source is included. Linear and circular already exclude it.
        if (i === 0 && j === 0) continue
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

/** A stored VEC3 field, or null when absent; a malformed value is a solve error. */
function storedVec3(feature: Dict, key: string): number[] | null {
  const v = feature[key]
  if (v === undefined || v === null) return null
  if (!Array.isArray(v) || v.length !== 3 || !v.every((c) => typeof c === 'number' && Number.isFinite(c))) {
    throw new Error(`circular_array: ${key} must be three finite numbers, got ${JSON.stringify(v)}`)
  }
  return v as number[]
}

/**
 * The circular array's rotation axis, with the same precedence transform uses
 * for its rotation: an `axis` pick wins; else the stored `axis_origin` /
 * `axis_direction` pair, where a direction alone rotates about the world
 * origin and an origin alone uses +Z (transform's rule, so one default holds
 * for both features). Neither is a solve error rather than a silent rotation
 * about a world axis. The schema accepted the pair long before the leaf read it.
 */
function resolveCircularAxis(
  feature: Dict,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
): [number[], number[]] {
  // The pick can be a straight edge, circular edge, sketch line, sketch
  // circle, cylindrical face, or planar face.
  const axisQuery = (feature.axis as string) ?? ''
  if (axisQuery) {
    const axis = resolveAxisQueryStrict(axisQuery, globalRepo, bodyStore)
    if (!axis) throw new Error(`circular_array: axis query '${axisQuery}' did not resolve to a usable axis`)
    return axis
  }
  const origin = storedVec3(feature, 'axis_origin')
  const direction = storedVec3(feature, 'axis_direction')
  if (origin === null && direction === null) {
    throw new Error(
      'circular_array: axis is required; pick an edge, sketch entity, or face as `axis`, ' +
        'or store the pair `axis_origin` + `axis_direction`',
    )
  }
  const dir = direction ?? [0, 0, 1]
  const len = Math.hypot(dir[0], dir[1], dir[2])
  if (len < 1e-12) throw new Error('circular_array: axis_direction must be a non-zero vector')
  return [origin ?? [0, 0, 0], dir.map((c) => c / len)]
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
  const [axisOrigin, resolvedDirection] = resolveCircularAxis(feature, globalRepo, bodyStore)
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
    // No source slot; sweep from the first step, never the seed. A sweep that
    // lands back on the seed (a full 360 wrap) drops that last copy, matching
    // the linear exclude behaviour of no copy at the source position.
    const wraps = step !== 0 && Math.abs((step * count) % 360) < 1e-9
    const n = wraps ? count - 1 : count
    for (let i = 1; i <= n; i++) {
      trsfs.push(makeRotationTrsf(oc, scope, axisOrigin, axisDirection, ((step * i) * Math.PI) / 180))
    }
  }
  return trsfs
}

/**
 * The solid of `shape` that owns one of `faces`, by face identity. `faces` are
 * the tracked images of the source body's own faces, so the solid containing
 * them is the source material: earlier copies' faces were never in the tracked
 * set. Used by the array add path to keep the source's persisted id.
 */
function solidHoldingFaces(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  faces: OccShape[],
): OccShape | null {
  if (faces.length === 0) return null
  for (const solid of exploreSolids(oc, scope, shape)) {
    const own = canonicalFaces(oc, scope, solid) as OccShape[]
    if (own.some((face) => faces.some((sf) => (face as OccSubShape).IsSame(sf as OccSubShape)))) return solid
  }
  return null
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
    // (M37 Change 2a). The count_x=1 no-op below never reads them.
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
    instanceNames.push(sourceNames())
  }
  // Same one-read-per-instance-loop hoist as the new branch: the source rows
  // are identical for every instance (M37 Change 2a).
  const rows = readSourceFaceRows(oc, scope, sourceShape, sourceNames().faceNames, sourceNames().faceAncestry)
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
  // The source body's own faces, tracked through every union by the boolean's
  // face origin. Whole-solid IsSame does not survive the clean pass on a
  // multi-face body (measured: a fused rail loses it on the first disjoint
  // union), while the face lineage does; a solid is then identified by any of
  // its own faces. Without this the split ranked siblings by centroid and gave
  // the source's id to a copy. The first union's target IS the source shape, so
  // its target-side origins seed the set without a second face walk.
  let sourceFaces: OccShape[] = []
  for (let i = 1; i < instances.length; i++) {
    const prev = fused
    const r = booleanWithDiff(oc, scope, fused, instances[i], 'fuse', { unifyFaces: !body.imported })
    fused = scope.track(r.shape)
    if (includeSource) {
      const next: OccShape[] = []
      const seen = new SubShapeDedup()
      const firstUnion = i === 1
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
      bodyShape: fused,
      faceOrigin: r.faceOrigin,
      targetFaceNames: fusedNames.faceNames,
      targetFaceAncestry: fusedNames.faceAncestry,
      targetCapAncestry: fusedNames.capAncestry,
      toolFaceNames: instanceNames[i].faceNames,
      toolFaceAncestry: instanceNames[i].faceAncestry,
      toolCapAncestry: instanceNames[i].capAncestry,
      // Each instance was already remapped to its own UUIDs by
      // `rebuildNamesForTransformedCopy`, so nothing collides.
      toolUuidScope: null,
    })
    fusedNames = names
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
  const body = resolveSourceBody(sub, bodyStore, 'array')
  const includeSource = (sub.include_source as boolean) ?? true
  const operation = (sub.operation as string) ?? 'add'
  const transforms = buildArrayTransforms(oc, scope, sub, globalRepo, bodyStore)
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
  const body = resolveSourceBody(sub, bodyStore, 'circular_array')
  const includeSource = (sub.include_source as boolean) ?? true
  const operation = (sub.operation as string) ?? 'add'
  const transforms = buildCircularTransforms(oc, scope, sub, globalRepo, bodyStore)
  return applyArray(oc, scope, table, body, transforms, includeSource, operation, featureId, bodyStore, 'circular_array')
}
