// The linear/rectangular array and circular array leaves. Both build a list of gp_Trsf instance
// transforms, copy the source body through each, and either fuse the copies into the source
// (operation "add") or spawn one new body per copy (operation "new"). Shared
// instance-application logic lives in `applyArray`.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape, OccTrsf } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body, BrepDiff } from '../types3d'
import type { Repository } from '../query'
import { bareBody, resolveBody, resolveDirectionQuery, resolveAxisQuery } from './shared'
import { makeTranslationTrsf, makeRotationTrsf, transformCopy } from '../occ/transforms'
import { booleanWithDiff } from '../occ/booleans'

type Dict = Record<string, unknown>

export interface ArrayResult {
  status: string
  body_id: string
  operation: string
}

/** Build linear/rectangular array instance transforms (mirrors `_build_array_transforms`). */
export function buildArrayTransforms(oc: OccModule, scope: DisposeScope, feature: Dict, globalRepo: Repository): OccTrsf[] {
  const mode = (feature.mode as string) ?? 'linear'
  const includeSource = (feature.include_source as boolean) ?? true
  const trsfs: OccTrsf[] = []

  if (mode === 'linear') {
    const countX = Math.trunc(Number(feature.count_x ?? 2))
    const pitchX = Number(feature.pitch_x ?? 10.0)
    const dirX = resolveDirectionQuery((feature.direction_x_query as string) ?? '', globalRepo, (feature.direction_x as number[]) ?? [1, 0, 0])
    const num = includeSource ? countX - 1 : countX
    for (let i = 1; i <= num; i++) {
      trsfs.push(makeTranslationTrsf(oc, scope, dirX[0] * pitchX * i, dirX[1] * pitchX * i, dirX[2] * pitchX * i))
    }
  } else if (mode === 'rectangular') {
    const countX = Math.trunc(Number(feature.count_x ?? 2))
    const countY = Math.trunc(Number(feature.count_y ?? 2))
    const pitchX = Number(feature.pitch_x ?? 10.0)
    const pitchY = Number(feature.pitch_y ?? 10.0)
    const dirX = resolveDirectionQuery((feature.direction_x_query as string) ?? '', globalRepo, (feature.direction_x as number[]) ?? [1, 0, 0])
    const dirY = resolveDirectionQuery((feature.direction_y_query as string) ?? '', globalRepo, (feature.direction_y as number[]) ?? [0, 1, 0])
    const numX = includeSource ? countX - 1 : countX
    for (let j = 0; j < countY; j++) {
      for (let i = 1; i <= numX; i++) {
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
  const count = Math.trunc(Number(feature.count ?? 4))
  const includeSource = (feature.include_source as boolean) ?? true
  const stepRaw = feature.step_angle
  const step = stepRaw === undefined || stepRaw === null ? 360.0 / count : Number(stepRaw)
  const [axisOrigin, axisDirection] = resolveAxisQuery(
    (feature.axis as string) ?? '',
    globalRepo,
    (feature.axis_origin as number[]) ?? [0, 0, 0],
    (feature.axis_direction as number[]) ?? [0, 0, 1],
    bodyStore,
  )
  const trsfs: OccTrsf[] = []
  const num = includeSource ? count - 1 : count
  for (let i = 1; i <= num; i++) {
    trsfs.push(makeRotationTrsf(oc, scope, axisOrigin, axisDirection, ((step * i) * Math.PI) / 180))
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
  const sourceShape = table.get<OccShape>(body.shape!)
  const instances: OccShape[] = []
  if (includeSource) instances.push(sourceShape)
  for (const trsf of transforms) instances.push(transformCopy(oc, scope, sourceShape, trsf))
  if (instances.length === 0) throw new Error(`${opLabel} produced no instances`)

  const resultBodyId = 'body_' + featureId

  if (operation === 'new') {
    const identity = scope.track(new oc.gp_Trsf_1())
    instances.forEach((shape, i) => {
      const bid = i === 0 ? resultBodyId : `${resultBodyId}_${i}`
      // Never co-own the live source handle: copy the source instance.
      const owned = includeSource && i === 0 ? transformCopy(oc, scope, sourceShape, identity) : shape
      const nb = bareBody(bid, featureId)
      nb.shape = table.register(scope.detach(owned), featureId)
      bodyStore[bid] = nb
    })
    return { status: 'ok', body_id: resultBodyId, operation: 'new' }
  }

  // operation "add": fuse incrementally; only the last union's diff is kept.
  if (instances.length === 1) {
    body.modified_by.push(featureId)
    body.brep_diff = null
    return { status: 'ok', body_id: body.id, operation: 'add' }
  }
  let fused = instances[0]
  let lastDiff: BrepDiff | null = null
  for (let i = 1; i < instances.length; i++) {
    const r = booleanWithDiff(oc, scope, fused, instances[i], 'fuse')
    fused = scope.track(r.shape)
    lastDiff = r.diff
  }
  const oldHandle = body.shape!
  body.shape = table.register(scope.detach(fused), body.created_by)
  table.release(oldHandle)
  body.modified_by.push(featureId)
  body.brep_diff = lastDiff
  return { status: 'ok', body_id: body.id, operation: 'add' }
}

function resolveSourceBody(
  feature: Dict,
  bodyStore: Record<string, Body>,
  opLabel: string,
): Body {
  const ref = (feature.source_body as string) ?? ''
  let body: Body
  if (ref) {
    try {
      body = resolveBody(ref, bodyStore)
    } catch {
      throw new Error(`${opLabel}: source body '${ref}' not found; available body IDs: ${JSON.stringify(Object.keys(bodyStore))}`)
    }
  } else {
    const ids = Object.keys(bodyStore)
    if (ids.length === 0) throw new Error(`${opLabel}: no source body with shape found`)
    body = bodyStore[ids[0]]
  }
  if (body.shape === null) throw new Error(`${opLabel}: source body has no shape`)
  return body
}

/** Solve a linear/rectangular array (mirrors `_solve_array`). */
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
  const transforms = buildArrayTransforms(oc, scope, merged, globalRepo)
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
