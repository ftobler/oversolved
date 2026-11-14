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
import type { PlaneLike } from './shared/planes'
import { resolvePlaneRef } from './shared/planes'
import { resolveBody, resolveBodyRefList } from './shared/bodyResolution'
import { makeMirrorTrsf, makeTranslationTrsf, makeRotationTrsf, makeScaleTrsf } from '../occ/transforms'
import { booleanWithDiff } from '../occ/booleans'
import { transformCopyWithMapping, rekeyNamesForTransformedBody, rebuildNamesForTransformedCopy, readSourceFaceRows, type NameMaps } from '../occ/transformLineage'
import { transferBooleanNames } from './booleanLineage'
import { registerSplitBodies, resplitBody } from './bodySplit'
import { readBodyNames } from '../occ/bodyNames'
import { precisionCeilingWarning } from '../precision'
import { quatFromEulerXyz, quatToAxisAngle } from '@/utils/transform3d'

type Dict = Record<string, unknown>

export interface TransformResult {
  [key: string]: unknown
  status: string
  body_id: string
  operation: string
  body_ids?: string[]
  solver_warning?: string
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
  // Params live in the kind sub-dict only; the solver adapter folds any legacy
  // flat params in before dispatch, so there is nothing to overlay here.
  const cfg = (feature.transform as Dict) ?? {}

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
  // The Euler triple and the axis spellings are alternatives. Presence is by
  // key on both sides, so an all-zero triple (or a stored angle of 0) still
  // counts as chosen and cannot slip past the ambiguity check. rotation_axis_origin
  // stays legal with the triple: it is the pivot.
  const eulerPresent = Object.hasOwn(cfg, 'rotation_euler')
  const axisSpellings = ['rotation_axis', 'rotation_angle', 'rotation_axis_direction']
    .filter((key) => Object.hasOwn(cfg, key))
  if (eulerPresent && axisSpellings.length > 0) {
    throw new Error(
      `transform: rotation_euler cannot be combined with ${axisSpellings.join(', ')}; ` +
        'use the Euler triple or one axis spelling, not both. Clear the other with a null value ' +
        '(set_transform_field with value: null).',
    )
  }
  let eulerRotation: { axis: [number, number, number]; angle: number } | null = null
  if (eulerPresent) {
    const eulerRaw = cfg.rotation_euler
    if (
      !Array.isArray(eulerRaw) || eulerRaw.length !== 3
      || !eulerRaw.every((component) => typeof component === 'number' && Number.isFinite(component))
    ) {
      throw new Error(
        `transform: rotation_euler must be three finite numbers of degrees, got ${JSON.stringify(eulerRaw)}`,
      )
    }
    const radians: [number, number, number] = [
      (eulerRaw[0] * Math.PI) / 180,
      (eulerRaw[1] * Math.PI) / 180,
      (eulerRaw[2] * Math.PI) / 180,
    ]
    // One quaternion -> one axis and angle -> one Trsf: the same composition
    // path as rotation_angle, so the Euler turn lands between scale and
    // translation rather than as three chained Multiply calls.
    eulerRotation = quatToAxisAngle(quatFromEulerXyz(radians))
  }
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
    // An explicit direction from cfg already counts as resolved; the query
    // exists to derive one, and a query that derives none is a bad pick.
    let axisResolved = rotationAxisDirection !== null
    const edge = getEdge3d(edgeRef, globalRepo)
    if (edge) {
      const [p0, p1] = edge
      const d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]
      const length = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2])
      if (length > 1e-10) {
        rotationAxisOrigin = [...p0]
        rotationAxisDirection = [d[0] / length, d[1] / length, d[2] / length]
        axisResolved = true
      }
    }
    // A pick whose endpoints are (nearly) coincident must fail loud instead of
    // letting the composition fall back to world Z and commit an arbitrary
    // rotation as a normal solve.
    if (!axisResolved && rotationAngle) {
      throw new Error(`transform: rotation_axis query '${axisQuery}' did not resolve to a non-degenerate edge`)
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
  if (eulerRotation !== null) {
    combined.Multiply(
      makeRotationTrsf(oc, scope, rotationAxisOrigin ?? [0, 0, 0], eulerRotation.axis, eulerRotation.angle),
    )
  } else if (rotationAngle) {
    const dir = rotationAxisDirection ?? [0, 0, 1]
    if (Math.hypot(dir[0], dir[1], dir[2]) < 1e-10) {
      throw new Error('transform: rotation axis direction must be a non-zero vector')
    }
    combined.Multiply(makeRotationTrsf(oc, scope, rotationAxisOrigin ?? [0, 0, 0], dir, (rotationAngle * Math.PI) / 180))
  }
  if (scale !== 1.0) {
    combined.Multiply(makeScaleTrsf(oc, scope, scaleCenter ?? [0, 0, 0], scale))
  }

  const operation = (cfg.operation as string) ?? 'new'
  const bodyIds: string[] = []
  let consumedReplace: string | null = null  // a source the replace resplit deleted (defensive)
  sources.forEach(({ body: sourceBody, shape: sourceHandle }, index) => {
    const sourceShape = table.get<OccShape>(sourceHandle)
    const sourceNames: NameMaps = readBodyNames(oc, scope, sourceShape, sourceBody)
    // One transform copy per source body, so there is nothing per-instance to
    // hoist: the source rows are read once here, per body (M37 Change 2a).
    const rows = readSourceFaceRows(oc, scope, sourceShape, sourceNames.faceNames, sourceNames.faceAncestry)
    const { shape: newShape, builder } = transformCopyWithMapping(oc, scope, sourceShape, combined)

    if (operation === 'replace') {
      const names = rekeyNamesForTransformedBody(oc, scope, newShape, sourceShape, sourceNames, builder)
      // A rigid transform cannot disconnect a body, but a non-uniform scale is in
      // the same composed Trsf, so this goes through the one path anyway rather
      // than resting on that argument.
      const ids = resplitBody(oc, scope, table, bodyStore, sourceBody, scope.track(newShape), featureId, names)
      if (ids.length === 0) {
        // Defensive: a transform copy cannot consume its source, but if the
        // resplit ever deleted it there is nothing to register here; the
        // post-loop guard turns that into a "nothing survives" result.
        consumedReplace = sourceBody.id
        return
      }
      bodyIds.push(...ids)
      sourceBody.modified_by = [...(sourceBody.modified_by ?? []), featureId]
      return
    }
    // `index` is the instance index the lineage remap mints fresh construction
    // UUIDs from, so two picked bodies cannot end up sharing face/edge UUIDs.
    // The new-body ids all share one base: `registerSplitBodies`' collision walk
    // then composes them into one flat, gap-free `body_<feature>[_n]` run.
    const names = rebuildNamesForTransformedCopy(oc, scope, newShape, rows, featureId, index, builder)
    bodyIds.push(...registerSplitBodies(oc, scope, table, bodyStore, scope.track(newShape), {
      id: 'body_' + featureId, createdBy: featureId, sketchId: sourceBody.sketch_id,
      profileQueries: sourceBody.profile_queries, precision: sourceBody.precision, ...names,
    }))
  })
  if (bodyIds.length === 0 && consumedReplace !== null) {
    // Every picked source was consumed (defensive; see the replace branch).
    // body_ids: [] says nothing survives; body_id names the body the feature
    // row points at.
    return {
      status: 'ok',
      body_id: consumedReplace,
      body_ids: [],
      operation: 'replace',
      solver_warning: `transform: the replace removed all of body '${consumedReplace}'; the body was deleted`,
    }
  }
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
  // Params live in the kind sub-dict only; see solveTransform.
  const cfg = (feature.mirror as Dict) ?? {}

  const bodyQuery = (cfg.body as string) ?? ''
  const sourceBody = bodyQuery ? resolveBody(bodyQuery, bodyStore) : null
  if (sourceBody === null || sourceBody.shape === null) {
    throw new Error(`mirror: body not found: ${JSON.stringify(bodyQuery)}`)
  }

  const planeQuery = (cfg.plane as string) ?? ''
  if (!planeQuery) throw new Error('mirror: plane is required')
  const { origin, normal } = resolvePlaneRef(globalRepo, planeQuery, bodyStore, 'mirror')

  const keepOriginal = (cfg.keep_original as boolean) ?? true
  const merge = (cfg.merge as boolean) ?? true

  const sourceShape = table.get<OccShape>(sourceBody.shape)
  const sourceNames: NameMaps = readBodyNames(oc, scope, sourceShape, sourceBody)
  // One mirror copy of one source body: no per-instance repetition, so the rows
  // are simply read once here (M37 Change 2a).
  const rows = readSourceFaceRows(oc, scope, sourceShape, sourceNames.faceNames, sourceNames.faceAncestry)
  const trsf = makeMirrorTrsf(oc, scope, origin, normal)
  const { shape: mirroredRaw, builder } = transformCopyWithMapping(oc, scope, sourceShape, trsf)
  const mirrored = scope.track(mirroredRaw)
  // When replacing (keep_original: false), preserve the original body's face
  // UUIDs so existing picks survive. When spawning a new body, mint fresh UUIDs.
  const mirroredNames = !keepOriginal
    ? rekeyNamesForTransformedBody(oc, scope, mirrored, sourceShape, sourceNames, builder)
    : rebuildNamesForTransformedCopy(oc, scope, mirrored, rows, featureId, 0, builder)

  if (!keepOriginal) {
    const bodyIds = resplitBody(oc, scope, table, bodyStore, sourceBody, scope.track(mirrored), featureId, mirroredNames)
    if (bodyIds.length === 0) {
      // Defensive: mirroring cannot consume a body, but if the resplit ever
      // deleted it, body_ids must not name a live id for a body that is gone.
      return {
        status: 'ok',
        body_id: sourceBody.id,
        body_ids: [],
        operation: 'replace',
        solver_warning: `mirror: the replace removed all of body '${sourceBody.id}'; the body was deleted`,
      }
    }
    sourceBody.modified_by.push(featureId)
    return { status: 'ok', body_id: bodyIds[0], body_ids: bodyIds, operation: 'replace' }
  }

  if (merge) {
    // A mirror is a fuse, so the merge reads the same reported precision the
    // source body carries: the mirrored copy is the same geometry.
    const precision = sourceBody.precision
    const res = booleanWithDiff(oc, scope, sourceShape, mirrored, 'fuse', {
      unifyFaces: !sourceBody.imported, precision,
    })
    const names = transferBooleanNames(oc, scope, {
      bodyShape: res.shape,
      faceOrigin: res.faceOrigin,
      targetFaceNames: sourceNames.faceNames,
      targetFaceAncestry: sourceNames.faceAncestry,
      targetCapAncestry: sourceNames.capAncestry,
      targetFaceOwner: sourceNames.faceOwner,
      targetEdgeOwner: sourceNames.edgeOwner,
      toolFaceNames: mirroredNames.faceNames,
      toolFaceAncestry: mirroredNames.faceAncestry,
      toolCapAncestry: mirroredNames.capAncestry,
      toolFaceOwner: mirroredNames.faceOwner,
      toolEdgeOwner: mirroredNames.edgeOwner,
      toolCreatedBy: featureId,
      // The mirrored copy already carries per-instance UUIDs, so nothing collides.
      toolUuidScope: null,
    })
    // "merge" is a fuse, and a body mirrored across a plane it does not reach
    // fuses into two disjoint solids: two parts, not one merged part.
    const bodyIds = resplitBody(
      oc, scope, table, bodyStore, sourceBody, scope.track(res.shape), featureId, names, null, precision,
    )
    if (bodyIds.length === 0) {
      // Defensive: a fuse of a body with its mirror cannot consume it, but if
      // the resplit ever deleted it, report the deletion rather than a live id.
      return {
        status: 'ok',
        body_id: sourceBody.id,
        body_ids: [],
        operation: 'merge',
        solver_warning: `mirror: the merge removed all of body '${sourceBody.id}'; the body was deleted`,
      }
    }
    sourceBody.modified_by.push(featureId)
    sourceBody.brep_diff = res.diff
    const ceiling = precision ? precisionCeilingWarning(precision) : null
    return {
      status: 'ok',
      body_id: bodyIds[0],
      body_ids: bodyIds,
      operation: 'merge',
      ...(ceiling !== null ? { solver_warning: ceiling } : {}),
    }
  }

  const newBodyId = 'body_' + featureId
  const newIds = registerSplitBodies(oc, scope, table, bodyStore, scope.track(mirrored), {
    id: newBodyId, createdBy: featureId, sketchId: sourceBody.sketch_id,
    profileQueries: sourceBody.profile_queries, precision: sourceBody.precision, ...mirroredNames,
  })
  return { status: 'ok', body_id: newIds[0], body_ids: newIds, operation: 'new' }
}
