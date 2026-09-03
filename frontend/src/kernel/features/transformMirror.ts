// The transform and mirror leaves. transform composes a scale/rotation/translation (with
// query-driven translation, rotation axis, and scale center) and either replaces its source
// bodies or spawns new ones. Its body pick is a LIST, and the one composed Trsf is applied
// to every picked body equally -- the transform is a property of the feature, not of any
// single body, so the axis, angle, scale centre and offset are resolved once. mirror
// reflects the source across a queried plane and either replaces, merges (union), or spawns
// a new body.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'
import { getPoint3d, type Repository } from '../query'
import type { PlaneLike } from './shared'
import { resolveBody, resolveBodyRefList } from './shared'
import { makeMirrorTrsf, makeTranslationTrsf, makeRotationTrsf, makeScaleTrsf } from '../occ/transforms'
import { booleanWithDiff } from '../occ/booleans'
import { transformCopyWithMapping, rekeyNamesForTransformedBody, rebuildNamesForTransformedCopy, type NameMaps } from '../occ/transformLineage'
import { transferBooleanNames } from './booleanLineage'
import { registerSplitBodies, resplitBody } from './bodySplit'

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

  // Every source body is resolved up front, before any shape is touched: a ref
  // that names nothing has to fail the feature outright rather than after half
  // the picks were already moved.
  const bodyQueries = (cfg.bodies as string[] | undefined) ?? []
  if (bodyQueries.length === 0) throw new Error('transform: no bodies picked')
  const sources = resolveBodyRefList(bodyQueries, globalRepo, bodyStore, 'transform').map((key) => {
    const body = bodyStore[key]
    // A resolved key is not automatically a live store key: the `?` branch of
    // resolveBodyRefKeys reads the id off the REPO (`body_id` on a face record),
    // which can name a body a later feature has since deleted. Diagnose it here
    // rather than let `body.shape` throw a bare TypeError out of the solve.
    if (body === undefined) throw new Error(`transform: body no longer exists: ${JSON.stringify(key)}`)
    if (body.shape === null) throw new Error(`transform: body has no shape: ${JSON.stringify(key)}`)
    return { body, shape: body.shape }
  })

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
  // NaN is falsy: without this guard a hand-edited NaN skipped BOTH the
  // missing-axis error below and the rotation itself, silently solving a
  // different transform than asked for.
  if (!Number.isFinite(rotationAngle)) {
    throw new Error(`transform: rotation_angle must be a finite number, got ${cfg.rotation_angle}`)
  }
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
  // NaN passes the `scale !== 1.0` check and would reach makeScaleTrsf.
  if (!Number.isFinite(scale)) {
    throw new Error(`transform: scale must be a finite number, got ${cfg.scale}`)
  }
  let scaleCenter = (cfg.scale_center as number[] | undefined) ?? null
  const scaleCenterQuery = cfg.scale_center_from as string | undefined
  if (scaleCenterQuery) {
    const ptRef = globalRepo.query(scaleCenterQuery, null, bodyStore) as Dict | null
    if (ptRef === null) throw new Error(`transform: scale_center_from not found: ${JSON.stringify(scaleCenterQuery)}`)
    scaleCenter = getPoint3d(ptRef, globalRepo)
  }

  // Compose the same transform pipeline applyTransformShape uses so we can
  // capture the builder's subshape mapping for name re-keying/remapping. Built
  // ONCE and reused for every picked body -- that is what "applied equally"
  // means, and it also keeps a query-driven axis or scale centre from being
  // re-resolved per body.
  const combined = scope.track(new oc.gp_Trsf_1())
  if (translation) {
    combined.Multiply(makeTranslationTrsf(oc, scope, translation[0], translation[1], translation[2]))
  }
  if (rotationAngle) {
    const dir = rotationAxisDirection ?? [0, 0, 1]
    combined.Multiply(makeRotationTrsf(oc, scope, rotationAxisOrigin ?? [0, 0, 0], dir, (rotationAngle * Math.PI) / 180))
  }
  if (scale !== 1.0) {
    combined.Multiply(makeScaleTrsf(oc, scope, scaleCenter ?? [0, 0, 0], scale))
  }

  const operation = (cfg.operation as string) ?? 'new'
  const bodyIds: string[] = []
  sources.forEach(({ body: sourceBody, shape: sourceHandle }, index) => {
    const sourceShape = table.get<OccShape>(sourceHandle)
    const sourceNames: NameMaps = {
      faceNames: sourceBody.face_names ?? {},
      faceAncestry: sourceBody.face_ancestry ?? {},
      edgeNames: sourceBody.edge_names ?? {},
      edgeAncestry: sourceBody.edge_ancestry ?? {},
    }
    const { shape: newShape, builder } = transformCopyWithMapping(oc, scope, sourceShape, combined)

    if (operation === 'replace') {
      const names = rekeyNamesForTransformedBody(oc, scope, newShape, sourceShape, sourceNames, builder)
      sourceBody.face_names = names.faceNames
      sourceBody.face_ancestry = names.faceAncestry
      sourceBody.edge_names = names.edgeNames
      sourceBody.edge_ancestry = names.edgeAncestry
      // A rigid transform cannot disconnect a body, but a non-uniform scale is in
      // the same composed Trsf, so this goes through the one path anyway rather
      // than resting on that argument.
      bodyIds.push(...resplitBody(oc, scope, table, bodyStore, sourceBody, scope.track(newShape), featureId))
      sourceBody.modified_by = [...(sourceBody.modified_by ?? []), featureId]
      return
    }
    // `index` is the instance index the lineage remap mints fresh construction
    // UUIDs from, so two picked bodies cannot end up sharing face/edge UUIDs.
    // The new-body ids all share one base: `registerSplitBodies`' collision walk
    // then composes them into one flat, gap-free `body_<feature>[_n]` run.
    const names = rebuildNamesForTransformedCopy(oc, scope, newShape, sourceShape, sourceNames, featureId, index, builder)
    bodyIds.push(...registerSplitBodies(oc, scope, table, bodyStore, scope.track(newShape), {
      id: 'body_' + featureId, createdBy: featureId, sketchId: sourceBody.sketch_id, ...names,
    }))
  })
  return {
    status: 'ok',
    body_id: bodyIds[0],
    body_ids: bodyIds,
    operation: operation === 'replace' ? 'replace' : 'new',
  }
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
  const sourceNames: NameMaps = {
    faceNames: sourceBody.face_names ?? {},
    faceAncestry: sourceBody.face_ancestry ?? {},
    edgeNames: sourceBody.edge_names ?? {},
    edgeAncestry: sourceBody.edge_ancestry ?? {},
  }
  const trsf = makeMirrorTrsf(oc, scope, [origin[0], origin[1], origin[2]], [normal[0], normal[1], normal[2]])
  const { shape: mirrored, builder } = transformCopyWithMapping(oc, scope, sourceShape, trsf)
  const mirroredNames = rebuildNamesForTransformedCopy(oc, scope, mirrored, sourceShape, sourceNames, featureId, 0, builder)

  if (!keepOriginal) {
    sourceBody.face_names = mirroredNames.faceNames
    sourceBody.face_ancestry = mirroredNames.faceAncestry
    sourceBody.edge_names = mirroredNames.edgeNames
    sourceBody.edge_ancestry = mirroredNames.edgeAncestry
    const bodyIds = resplitBody(oc, scope, table, bodyStore, sourceBody, scope.track(mirrored), featureId)
    sourceBody.modified_by.push(featureId)
    return { status: 'ok', body_id: bodyIds[0], body_ids: bodyIds, operation: 'replace' }
  }

  if (merge) {
    const res = booleanWithDiff(oc, scope, sourceShape, mirrored, 'fuse', { unifyFaces: !sourceBody.imported })
    const names = transferBooleanNames(oc, scope, {
      bodyShape: res.shape,
      faceOrigin: res.faceOrigin,
      targetFaceNames: sourceNames.faceNames,
      targetFaceAncestry: sourceNames.faceAncestry,
      toolFaceNames: mirroredNames.faceNames,
      toolFaceAncestry: mirroredNames.faceAncestry,
      // The mirrored copy already carries per-instance UUIDs, so nothing collides.
      toolUuidScope: null,
    })
    sourceBody.face_names = names.face_names
    sourceBody.face_ancestry = names.face_ancestry
    sourceBody.edge_names = names.edge_names
    sourceBody.edge_ancestry = names.edge_ancestry
    // "merge" is a fuse, and a body mirrored across a plane it does not reach
    // fuses into two disjoint solids: two parts, not one merged part.
    const bodyIds = resplitBody(oc, scope, table, bodyStore, sourceBody, scope.track(res.shape), featureId)
    sourceBody.modified_by.push(featureId)
    sourceBody.brep_diff = res.diff
    return { status: 'ok', body_id: bodyIds[0], body_ids: bodyIds, operation: 'merge' }
  }

  const newBodyId = 'body_' + featureId
  const newIds = registerSplitBodies(oc, scope, table, bodyStore, scope.track(mirrored), {
    id: newBodyId, createdBy: featureId, sketchId: sourceBody.sketch_id, ...mirroredNames,
  })
  return { status: 'ok', body_id: newIds[0], body_ids: [sourceBody.id, ...newIds], operation: 'new' }
}
