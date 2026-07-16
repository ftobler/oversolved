// The revolve leaf, analogous to extrude but sweeping each profile around an axis. It resolves
// each profile to 2D loops (or a body face), resolves the revolve axis (a stored
// origin/direction plus an optional `axis` query that flips to agree with the stored
// direction), builds the tool solid with per-entity lineage, and applies the body operation.
//
// The axis logic here is revolve-specific and does NOT go through shared.ts's resolveAxisQuery:
// _solve_revolve flips the queried axis to match the feature's stored direction (so re-solving
// a flipped edge does not reverse the body), which resolveAxisQuery (used by circular_array)
// deliberately omits.

import type { DisposeScope } from '../occ/disposeScope'
import { extractErrorMessage } from '../errors'
import type { OccModule, OccShape } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'
import type { Repository } from '../query'
import { booleanWithHistory } from '../occ/booleans'
import { collectExtrudeLoops } from './faceProfile'
import { sketchToWorld2d, surfaceEntityIds, type PlaneLike } from './shared'
import { applyBodyOperation, type BodyOperation } from './bodyOps'
import { revolveFace, revolveProfileWithLineage } from '../occ/prismLineage'
import { faceCentroid, type Vec3 } from '../occ/primitives'
import { loopCentroid } from '../profileLoops'
import { angularHandle } from './featureHandles'

type Dict = Record<string, unknown>
type Lineage = Record<string, string[]>

interface RevolveResult {
  [key: string]: unknown
  status: string
  body_id: string
}

function fuse(oc: OccModule, scope: DisposeScope, a: OccShape, b: OccShape): OccShape {
  return booleanWithHistory(oc, scope, a, b, 'fuse').shape
}

/**
 * Resolve the revolve axis (mirrors the inline block in `_solve_revolve`). Starts
 * from the stored origin/direction; an `axis` query overrides them but is flipped
 * (origin becomes the line's far end, direction negated) when it points opposite
 * the stored direction.
 *
 * Fail-loud guards: when an `axis` query is set but the registry returns null
 * (stale pick -- the body rebuild minted new ancestry tokens, the edge was
 * deleted, or the sketch line was removed), OR when the resolved payload carries
 * no usable axis geometry (a degenerate line, a missing sketch plane, or an
 * unrecognised shape), the resolver throws instead of silently falling back to
 * the default [0,0,0]/[0,0,1] axis. A silent fallback there produces a wrong
 * (squished) solid the user can't diagnose; a thrown error surfaces the revolve
 * as a red feature so the user re-picks the axis. Mirrors the rotation-axis
 * guard in transformMirror (`transform: rotation_axis not found`).
 */
export function resolveRevolveAxis(
  feature: Dict,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
): [number[], number[]] {
  let axisOrigin = (feature.axis_origin as number[]) ?? [0, 0, 0]
  let axisDirection = (feature.axis_direction as number[]) ?? [0, 0, 1]
  const storedDirection = [...axisDirection]
  const axisQuery = feature.axis as string | undefined
  if (!axisQuery) return [axisOrigin, axisDirection]

  const axisData = globalRepo.query(axisQuery, null, bodyStore) as Dict | null
  if (axisData === null) {
    throw new Error(`revolve: axis query did not resolve: ${JSON.stringify(axisQuery)}`)
  }

  // Tracks whether any branch actually produced an axis. The branches below can
  // all silently no-op (a degenerate line, a zero-length axis, a missing sketch
  // plane); without this flag the resolver would silently return the stored
  // default -- the fail-wrong path the throw below closes.
  let applied = false

  const apply = (start: number[], end: number[]): void => {
    const dx = end[0] - start[0]
    const dy = end[1] - start[1]
    const dz = end[2] - start[2]
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (length <= 1e-12) return
    const computed = [dx / length, dy / length, dz / length]
    const dot = computed[0] * storedDirection[0] + computed[1] * storedDirection[1] + computed[2] * storedDirection[2]
    if (dot < 0) {
      axisOrigin = [...end]
      axisDirection = [-computed[0], -computed[1], -computed[2]]
    } else {
      axisOrigin = [...start]
      axisDirection = computed
    }
    applied = true
  }

  if ('start' in axisData && 'end' in axisData) {
    apply(axisData.start as number[], axisData.end as number[])
  } else if ('center' in axisData && 'axis' in axisData) {
    // Circle / arc / ellipse edge: the center sits on the rotation axis and the
    // axis field (the circle's plane normal) is the rotation direction, flipped
    // to match the stored direction (same sign convention as the line-edge arm).
    const raw = axisData.axis as number[]
    const axLen = Math.sqrt(raw[0] * raw[0] + raw[1] * raw[1] + raw[2] * raw[2])
    if (axLen > 1e-12) {
      const normal: number[] = [raw[0] / axLen, raw[1] / axLen, raw[2] / axLen]
      const dot = normal[0] * storedDirection[0] + normal[1] * storedDirection[1] + normal[2] * storedDirection[2]
      axisOrigin = [...(axisData.center as number[])]
      axisDirection = dot < 0 ? [-normal[0], -normal[1], -normal[2]] : normal
      applied = true
    }
  } else if ('external_params' in axisData && axisData.kind === 'line') {
    const sketchId = (axisData.sketch_id as string) ?? ''
    const plane = sketchId ? (globalRepo.elements.get('_pt_' + sketchId) as PlaneLike | undefined) : undefined
    if (plane) {
      const params = axisData.external_params as number[]
      apply(sketchToWorld2d(params.slice(0, 2), plane), sketchToWorld2d(params.slice(2, 4), plane))
    }
  }

  if (!applied) {
    throw new Error(
      'revolve: resolved axis payload carries no usable axis ' +
        `(missing start/end, center/axis, or external_params+sketch plane for): ${JSON.stringify(axisQuery)}`,
    )
  }
  return [axisOrigin, axisDirection]
}

/** Solve a revolve feature into the body store (mirrors `_solve_revolve`). */
export function solveRevolve(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
): RevolveResult {
  const featureId = (feature.id as string) ?? ''
  const sub = (feature.revolve as Dict) ?? {}
  const mergeTarget = ((sub.merge_target as string) ?? (feature.merge_target as string)) ?? null
  const merged: Dict = { ...sub, ...feature }

  const sketchRaw = merged.sketch
  const sketchRefs: string[] = Array.isArray(sketchRaw)
    ? (sketchRaw as string[]).filter((s) => s)
    : sketchRaw
      ? [sketchRaw as string]
      : []
  const angle = Number((merged.angle as number) || 360.0)

  if (angle === 0) throw new Error('revolve: angle must be non-zero')
  if (sketchRefs.length === 0) throw new Error('revolve: requires at least one profile reference')

  const allLoops: Dict[][] = []
  const cqFaces: OccShape[] = []
  let firstPt: PlaneLike | null = null
  let firstSketchId = ''
  const profileErrors: string[] = []
  const profileQueries: string[] = []
  const faceLineage: Lineage = {}
  const edgeLineage: Lineage = {}
  const faceNames: Record<string, string> = {}
  const edgeNames: Record<string, string> = {}
  const faceAncestry: Lineage = {}
  const edgeAncestry: Lineage = {}

  for (const sketchRef of sketchRefs) {
    let resolved
    try {
      resolved = collectExtrudeLoops(oc, scope, table, sketchRef, featureId, 0.0, globalRepo, bodyStore)
    } catch (exc) {
      profileErrors.push(extractErrorMessage(exc))
      continue
    }
    if (resolved.face !== null) {
      cqFaces.push(resolved.face)
    } else {
      allLoops.push(...resolved.loops)
    }
    const topo = (globalRepo.elements.get('_topo_' + resolved.sketchId) as Dict | undefined) ?? {}
    for (const surface of (topo.surfaces as Dict[]) ?? []) {
      profileQueries.push(...surfaceEntityIds(surface))
    }
    if (firstPt === null) {
      firstPt = resolved.plane
      firstSketchId = resolved.sketchId
    }
  }

  if (profileErrors.length && cqFaces.length === 0 && allLoops.length === 0) {
    throw new Error(profileErrors.join('; '))
  }

  const [axisOrigin, axisDirection] = resolveRevolveAxis(merged, globalRepo, bodyStore)
  const ao = axisOrigin as Vec3
  const ad = axisDirection as Vec3

  const bodyId = 'body_' + featureId
  const result: RevolveResult = { status: 'ok', body_id: bodyId }
  const operation = ((merged.operation as string) ?? 'add') as BodyOperation
  const direction = (merged.direction as string) ?? 'normal'

  let toolShape: OccShape
  if (cqFaces.length === 0 && allLoops.length === 0) {
    // No profile geometry resolved -> no part. A part-less revolve is a failed
    // revolve (surfaced as a red feature), not a silent ok.
    result.status = 'error'
    result.exception = 'revolve: no closed profile found in the referenced sketch; no part created'
    result.mesh_warning = 'no closed profile found; body has no shape'
    return result
  } else if (cqFaces.length > 0 && allLoops.length === 0) {
    if (direction === 'symmetric') {
      const half = angle / 2.0
      let tool = fuse(
        oc,
        scope,
        revolveFace(oc, scope, cqFaces[0], ao, ad, half),
        revolveFace(oc, scope, cqFaces[0], ao, ad, -half),
      )
      for (const f of cqFaces.slice(1)) {
        const pos = revolveFace(oc, scope, f, ao, ad, half)
        const neg = revolveFace(oc, scope, f, ao, ad, -half)
        tool = fuse(oc, scope, tool, fuse(oc, scope, pos, neg))
      }
      toolShape = tool
    } else {
      const eff = direction === 'reverse' ? -angle : angle
      let tool = revolveFace(oc, scope, cqFaces[0], ao, ad, eff)
      for (const f of cqFaces.slice(1)) tool = fuse(oc, scope, tool, revolveFace(oc, scope, f, ao, ad, eff))
      toolShape = tool
    }
  } else {
    if (direction === 'symmetric') {
      // The two halves are minted with no createdBy: their side faces come from
      // the same profile entities, so a shared UUID would collide; the fused
      // solid falls back to ancestral naming (documented limitation).
      const half = angle / 2.0
      const pos = revolveProfileWithLineage(oc, scope, allLoops, firstPt as PlaneLike, ao, ad, half, firstSketchId)
      const neg = revolveProfileWithLineage(oc, scope, allLoops, firstPt as PlaneLike, ao, ad, -half, firstSketchId)
      toolShape = fuse(oc, scope, pos.solid, neg.solid)
      Object.assign(faceLineage, pos.faceLineage, neg.faceLineage)
      Object.assign(edgeLineage, pos.edgeLineage, neg.edgeLineage)
    } else {
      const eff = direction === 'reverse' ? -angle : angle
      const lineage = revolveProfileWithLineage(oc, scope, allLoops, firstPt as PlaneLike, ao, ad, eff, firstSketchId, featureId)
      toolShape = lineage.solid
      Object.assign(faceLineage, lineage.faceLineage)
      Object.assign(edgeLineage, lineage.edgeLineage)
      Object.assign(faceNames, lineage.faceNames)
      Object.assign(edgeNames, lineage.edgeNames)
      Object.assign(faceAncestry, lineage.faceAncestry)
      Object.assign(edgeAncestry, lineage.edgeAncestry)
    }
  }

  // Editing handle: draggable angle arrow at the profile reference point swept
  // to the end of the revolution, pulling along the sweep tangent.
  let refPoint: number[] | null = null
  if (cqFaces.length > 0 && allLoops.length === 0) {
    refPoint = faceCentroid(oc, scope, cqFaces[0])
  } else if (firstPt !== null && allLoops.length > 0) {
    refPoint = sketchToWorld2d(loopCentroid(allLoops[0]), firstPt)
  }
  if (refPoint !== null) {
    const handle = angularHandle('angle', ao, ad, refPoint, angle, direction)
    if (handle !== null) result.handle = handle
  }

  const opResult = applyBodyOperation(oc, scope, table, {
    toolShape,
    bodyStore,
    operation,
    mergeTarget,
    bodyId,
    featureId,
    sketchId: firstSketchId,
    opName: 'revolve',
    profileQueries,
    faceLineage,
    edgeLineage,
    faceNames,
    edgeNames,
    faceAncestry,
    edgeAncestry,
  })
  Object.assign(result, opResult)

  if (profileErrors.length) {
    result.status = 'partial'
    result.exception = profileErrors.join('; ')
  }

  return result
}
