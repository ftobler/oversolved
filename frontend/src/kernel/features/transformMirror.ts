// The transform and mirror leaves. transform composes a scale/rotation/translation (with
// query-driven translation, rotation axis, and scale center) and either replaces the source
// body or spawns a new one. mirror reflects the source across a queried plane and either
// replaces, merges (union), or spawns a new body.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'
import { getPoint3d, type Repository } from '../query'
import type { PlaneLike } from './shared'
import { bareBody, resolveBody } from './shared'
import { applyTransformShape, makeMirrorTrsf, transformCopy } from '../occ/transforms'
import { booleanWithDiff } from '../occ/booleans'

type Dict = Record<string, unknown>

export interface TransformResult {
  status: string
  body_id: string
  operation: string
  body_ids?: string[]
}

/** Query-result -> [start, end] (mirrors `_get_edge_3d`). */
function getEdge3d(ref: Dict, globalRepo: Repository): [number[], number[]] | null {
  if ('external_params' in ref && ref.kind === 'line') {
    const p = ref.external_params as number[]
    const sketchId = ref.sketch_id as string | undefined
    if (sketchId) {
      const pt = globalRepo.elements.get('_pt_' + sketchId) as PlaneLike | undefined
      if (pt) {
        const lift = (a: number, b: number): number[] => [
          pt.origin[0] + a * pt.x_axis[0] + b * pt.y_axis[0],
          pt.origin[1] + a * pt.x_axis[1] + b * pt.y_axis[1],
          pt.origin[2] + a * pt.x_axis[2] + b * pt.y_axis[2],
        ]
        return [lift(p[0], p[1]), lift(p[2], p[3])]
      }
    }
    return [[p[0], p[1], 0.0], [p[2], p[3], 0.0]]
  }
  if ('start' in ref && 'end' in ref) return [ref.start as number[], ref.end as number[]]
  throw new Error('edge reference has no line coordinates')
}

/** Solve a transform feature (mirrors `_solve_transform`). */
export function solveTransform(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
): TransformResult {
  const featureId = (feature.id as string) ?? ''
  const sub = (feature.transform as Dict) ?? {}
  const { transform: _t, ...rest } = feature
  const cfg: Dict = { ...sub, ...rest }

  const bodyQuery = (cfg.body as string) ?? ''
  const sourceBody = bodyQuery ? resolveBody(bodyQuery, bodyStore) : null
  if (sourceBody === null || sourceBody.shape === null) {
    throw new Error(`transform: body not found: ${JSON.stringify(bodyQuery)}`)
  }

  let translation = (cfg.translation as number[] | undefined) ?? null
  const trFrom = cfg.translation_from as string | undefined
  const trTo = cfg.translation_to as string | undefined
  if (trFrom && trTo) {
    const p0Ref = globalRepo.query(trFrom, null, bodyStore) as Dict | null
    const p1Ref = globalRepo.query(trTo, null, bodyStore) as Dict | null
    if (p0Ref === null) throw new Error(`transform: translation_from not found: ${JSON.stringify(trFrom)}`)
    if (p1Ref === null) throw new Error(`transform: translation_to not found: ${JSON.stringify(trTo)}`)
    const p0 = getPoint3d(p0Ref, globalRepo)
    const p1 = getPoint3d(p1Ref, globalRepo)
    translation = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]
  }

  const rotationAngle = Number(cfg.rotation_angle ?? 0.0)
  let rotationAxisOrigin = (cfg.rotation_axis_origin as number[] | undefined) ?? null
  let rotationAxisDirection = (cfg.rotation_axis_direction as number[] | undefined) ?? null
  const axisQuery = cfg.rotation_axis as string | undefined
  if (rotationAngle && !axisQuery && !rotationAxisOrigin && !rotationAxisDirection) {
    throw new Error(
      `transform: rotation_angle is ${rotationAngle} but no rotation axis specified; ` +
        'provide rotation_axis, rotation_axis_origin+direction, or set rotation_angle=0',
    )
  }
  if (axisQuery) {
    const edgeRef = globalRepo.query(axisQuery, null, bodyStore) as Dict | null
    if (edgeRef === null) throw new Error(`transform: rotation_axis not found: ${JSON.stringify(axisQuery)}`)
    const edge = getEdge3d(edgeRef, globalRepo)
    if (edge) {
      const [p0, p1] = edge
      const d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]
      const length = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2])
      if (length > 1e-10) {
        rotationAxisOrigin = [...p0]
        rotationAxisDirection = [d[0] / length, d[1] / length, d[2] / length]
      }
    }
  }

  const scale = Number(cfg.scale ?? 1.0)
  let scaleCenter = (cfg.scale_center as number[] | undefined) ?? null
  const scaleCenterQuery = cfg.scale_center_from as string | undefined
  if (scaleCenterQuery) {
    const ptRef = globalRepo.query(scaleCenterQuery, null, bodyStore) as Dict | null
    if (ptRef === null) throw new Error(`transform: scale_center_from not found: ${JSON.stringify(scaleCenterQuery)}`)
    scaleCenter = getPoint3d(ptRef, globalRepo)
  }

  const sourceShape = table.get<OccShape>(sourceBody.shape)
  const newShape = applyTransformShape(oc, scope, sourceShape, {
    translation,
    rotationAxisOrigin,
    rotationAxisDirection,
    rotationAngleDeg: rotationAngle,
    scale,
    scaleCenter,
  })

  const operation = (cfg.operation as string) ?? 'new'
  if (operation === 'replace') {
    const oldHandle = sourceBody.shape
    sourceBody.shape = table.register(scope.detach(scope.track(newShape)), sourceBody.created_by)
    table.release(oldHandle)
    sourceBody.modified_by = [...(sourceBody.modified_by ?? []), featureId]
    return { status: 'ok', body_id: sourceBody.id, operation: 'replace' }
  }
  const newBodyId = 'body_' + featureId
  const nb = bareBody(newBodyId, featureId, sourceBody.sketch_id)
  nb.shape = table.register(scope.detach(scope.track(newShape)), featureId)
  bodyStore[newBodyId] = nb
  return { status: 'ok', body_id: newBodyId, operation: 'new' }
}

/** Solve a mirror feature (mirrors `_solve_mirror`). */
export function solveMirror(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
): TransformResult {
  const featureId = (feature.id as string) ?? ''
  const sub = (feature.mirror as Dict) ?? {}
  const { mirror: _m, ...rest } = feature
  const cfg: Dict = { ...sub, ...rest }

  const bodyQuery = (cfg.body as string) ?? ''
  const sourceBody = bodyQuery ? resolveBody(bodyQuery, bodyStore) : null
  if (sourceBody === null || sourceBody.shape === null) {
    throw new Error(`mirror: body not found: ${JSON.stringify(bodyQuery)}`)
  }

  const planeQuery = (cfg.plane as string) ?? ''
  if (!planeQuery) throw new Error('mirror: plane is required')
  const planeData = globalRepo.query(planeQuery, null, bodyStore) as Dict | null
  if (planeData === null) throw new Error(`mirror: plane not found: ${JSON.stringify(planeQuery)}`)
  let origin: number[]
  let normal: number[]
  if ('x_axis' in planeData && 'normal' in planeData && 'origin' in planeData && !('type' in planeData)) {
    origin = planeData.origin as number[]
    normal = planeData.normal as number[]
  } else if (planeData.type === 'flatface' || planeData.type === 'plane') {
    origin = (planeData.origin as number[]) ?? [0, 0, 0]
    normal = (planeData.normal as number[]) ?? [0, 0, 1]
  } else {
    throw new Error(`mirror: plane query did not resolve to a plane: ${JSON.stringify(planeQuery)}`)
  }

  const keepOriginal = (cfg.keep_original as boolean) ?? true
  const merge = (cfg.merge as boolean) ?? true

  const sourceShape = table.get<OccShape>(sourceBody.shape)
  const trsf = makeMirrorTrsf(oc, scope, [origin[0], origin[1], origin[2]], [normal[0], normal[1], normal[2]])
  const mirrored = scope.track(transformCopy(oc, scope, sourceShape, trsf))

  if (!keepOriginal) {
    const oldHandle = sourceBody.shape
    sourceBody.shape = table.register(scope.detach(mirrored), sourceBody.created_by)
    table.release(oldHandle)
    sourceBody.modified_by.push(featureId)
    return { status: 'ok', body_id: sourceBody.id, operation: 'replace' }
  }

  if (merge) {
    const res = booleanWithDiff(oc, scope, sourceShape, mirrored, 'fuse')
    const oldHandle = sourceBody.shape
    sourceBody.shape = table.register(scope.detach(scope.track(res.shape)), sourceBody.created_by)
    table.release(oldHandle)
    sourceBody.modified_by.push(featureId)
    sourceBody.brep_diff = res.diff
    return { status: 'ok', body_id: sourceBody.id, operation: 'merge' }
  }

  const newBodyId = 'body_' + featureId
  const nb = bareBody(newBodyId, featureId, sourceBody.sketch_id)
  nb.shape = table.register(scope.detach(mirrored), featureId)
  bodyStore[newBodyId] = nb
  return { status: 'ok', body_id: newBodyId, body_ids: [sourceBody.id, newBodyId], operation: 'new' }
}
