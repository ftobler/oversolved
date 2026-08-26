// The extrude leaf, the simplest brep producer and the first phase-2f feature. It resolves each
// profile reference to 2D loops (or a body face), builds the tool solid with per-entity
// lineage, and applies the body operation (add / cut / new).
//
// This is the wiring layer: collectExtrudeLoops (faceProfile.ts), resolveDirection (shared.ts),
// extrudeProfileWithLineage (occ/prismLineage.ts), and applyBodyOperation (bodyOps.ts) do the
// work. Like every OCC-backed leaf it takes (oc, scope, table) ahead of the Python (feature,
// globalRepo, bodyStore) signature; the caller owns `scope` and disposes it after ancestry
// registration.

import type { DisposeScope } from '../occ/disposeScope'
import { extractErrorMessage } from '../errors'
import type { OccModule, OccShape } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'
import type { Repository } from '../query'
import { faceNormal, faceCentroid, makePrism, type Vec3 } from '../occ/primitives'
import { booleanWithHistory } from '../occ/booleans'
import { collectExtrudeLoops } from './faceProfile'
import { resolveDirection, surfaceEntityIds, sketchToWorld2d, type PlaneLike } from './shared'
import { loopCentroid } from '../profileLoops'
import { linearHandle, offsetAlong } from './featureHandles'
import { applyBodyOperation, type BodyOperation } from './bodyOps'
import { extrudeProfileWithLineage } from '../occ/prismLineage'
import { isEdgeProfileRef, resolveEdgeProfileFace } from './edgeProfile'
import { resolveUpToPlane, orientToTarget, trimAtPlane, UP_TO_REACH, type CutPlane } from './upTo'

type Dict = Record<string, unknown>
type Lineage = Record<string, string[]>

interface ExtrudeResult {
  [key: string]: unknown
  status: string
  body_id: string
  // Every body the operation produced; `body_id` is just the first (features/bodySplit.ts).
  body_ids?: string[]
}

function fuse(oc: OccModule, scope: DisposeScope, a: OccShape, b: OccShape): OccShape {
  return booleanWithHistory(oc, scope, a, b, 'fuse').shape
}

/** Solve an extrude feature into the body store (mirrors `_solve_extrude`). */
export function solveExtrude(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
): ExtrudeResult {
  const featureId = (feature.id as string) ?? ''
  const sub = (feature.extrude as Dict) ?? {}
  const mergeTarget = ((sub.merge_target as string) ?? (feature.merge_target as string)) ?? null
  const merged: Dict = { ...sub, ...feature }

  const sketchRaw = merged.sketch
  const sketchRefs: string[] = Array.isArray(sketchRaw)
    ? (sketchRaw as string[]).filter((s) => s)
    : sketchRaw
      ? [sketchRaw as string]
      : []
  // Nullish, not truthy: an explicit distance=0 must survive to the non-zero
  // validation below instead of silently becoming the default depth.
  const distance = Number(
    (merged.distance as number | null | undefined) ?? (merged.depth as number | null | undefined) ?? 1.0,
  )

  if (!Number.isFinite(distance) || distance === 0) throw new Error('extrude: distance must be non-zero')
  if (sketchRefs.length === 0) {
    throw new Error('extrude: requires at least one profile reference')
  }

  // B-rep edge picks define their profile from selected solid edges, not from a
  // sketch or a whole face; they resolve to an assembled planar face below and
  // join the cqFaces path. Everything else (sketch/face/surface refs) keeps the
  // original loop-collection route.
  const edgeRefs = sketchRefs.filter(isEdgeProfileRef)
  const profileRefs = sketchRefs.filter((s) => !isEdgeProfileRef(s))

  const allLoops: Dict[][] = []
  const cqFaces: OccShape[] = []
  let firstPt: PlaneLike | null = null
  let firstSketchId = ''
  const profileErrors: string[] = []
  const profileQueries: string[] = []
  const faceNames: Record<string, string> = {}
  const edgeNames: Record<string, string> = {}
  const faceAncestry: Lineage = {}
  const edgeAncestry: Lineage = {}

  for (const sketchRef of profileRefs) {
    let resolved
    try {
      resolved = collectExtrudeLoops(
        oc,
        scope,
        table,
        sketchRef,
        featureId,
        distance,
        globalRepo,
        bodyStore,
      )
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

  // All picked edges together bound one coplanar profile loop -> one face.
  if (edgeRefs.length > 0) {
    try {
      cqFaces.push(resolveEdgeProfileFace(oc, scope, table, edgeRefs, bodyStore))
    } catch (exc) {
      profileErrors.push(extractErrorMessage(exc))
    }
  }

  if (profileErrors.length && cqFaces.length === 0 && allLoops.length === 0) {
    throw new Error(profileErrors.join('; '))
  }

  const bodyId = 'body_' + featureId
  const result: ExtrudeResult = { status: 'ok', body_id: bodyId }
  const operation = ((merged.operation as string) ?? 'add') as BodyOperation
  const direction = (merged.direction as string) ?? 'normal'

  if (cqFaces.length === 0 && allLoops.length === 0) {
    // No profile geometry resolved -> no part. A part-less extrude is a failed
    // extrude (surfaced as a red feature), not a silent ok. (profileErrors are
    // already empty here -- a non-empty set threw above.)
    result.status = 'error'
    result.exception = 'extrude: no closed profile found in the referenced sketch; no part created'
    result.mesh_warning = 'no closed profile found; body has no shape'
    return result
  }

  // Up-to termination: resolve the cut plane once, using a representative extrude
  // direction so a point target can take the extrude direction as its normal.
  const termination = (merged.termination as string) ?? 'blind'
  const upToRef = (merged.up_to as string) ?? ''
  const usingFaces = cqFaces.length > 0 && allLoops.length === 0
  let cutPlane: CutPlane | null = null
  if (termination === 'up_to' && upToRef) {
    if (direction === 'symmetric') {
      throw new Error('extrude up_to: symmetric direction is not supported')
    }
    const probeDir: Vec3 = usingFaces
      ? (direction === 'reverse'
          ? (faceNormal(oc, scope, cqFaces[0]).map((n) => -n) as Vec3)
          : (faceNormal(oc, scope, cqFaces[0]) as Vec3))
      : (resolveDirection((firstPt?.normal as number[]) ?? [0, 0, 1], firstPt as PlaneLike, direction, distance)[0] as Vec3)
    cutPlane = resolveUpToPlane(oc, scope, table, upToRef, probeDir, globalRepo, bodyStore)
    if (cutPlane === null) {
      result.solver_warning = `extrude: up_to target '${upToRef}' did not resolve; used blind distance`
    }
  }

  let toolShape: OccShape
  if (usingFaces) {
    const faceNormalVec = faceNormal(oc, scope, cqFaces[0])
    const reverseVec = faceNormalVec.map((n) => -n) as Vec3
    if (cutPlane !== null) {
      const nominal = (direction === 'reverse' ? reverseVec : faceNormalVec) as Vec3
      const dirVec = orientToTarget(cutPlane, faceCentroid(oc, scope, cqFaces[0]), nominal)
      let tool = makePrism(oc, scope, cqFaces[0], dirVec, UP_TO_REACH)
      for (const f of cqFaces.slice(1)) tool = fuse(oc, scope, tool, makePrism(oc, scope, f, dirVec, UP_TO_REACH))
      toolShape = trimAtPlane(oc, scope, tool, cutPlane, dirVec)
    } else if (direction === 'symmetric') {
      const half = distance / 2.0
      let tool = fuse(
        oc,
        scope,
        makePrism(oc, scope, cqFaces[0], faceNormalVec, half),
        makePrism(oc, scope, cqFaces[0], reverseVec, half),
      )
      for (const f of cqFaces.slice(1)) {
        const pos = makePrism(oc, scope, f, faceNormalVec, half)
        const neg = makePrism(oc, scope, f, reverseVec, half)
        tool = fuse(oc, scope, tool, fuse(oc, scope, pos, neg))
      }
      toolShape = tool
    } else if (direction === 'reverse') {
      let tool = makePrism(oc, scope, cqFaces[0], reverseVec, distance)
      for (const f of cqFaces.slice(1)) tool = fuse(oc, scope, tool, makePrism(oc, scope, f, reverseVec, distance))
      toolShape = tool
    } else {
      let tool = makePrism(oc, scope, cqFaces[0], faceNormalVec, distance)
      for (const f of cqFaces.slice(1)) tool = fuse(oc, scope, tool, makePrism(oc, scope, f, faceNormalVec, distance))
      toolShape = tool
    }
  } else {
    const normal = (firstPt?.normal as number[]) ?? [0, 0, 1]
    const [directionVec, effectiveDistance, effectivePlane] = resolveDirection(
      normal,
      firstPt as PlaneLike,
      direction,
      distance,
    )
    const length = cutPlane !== null ? UP_TO_REACH : effectiveDistance
    const sweepDir = cutPlane !== null
      ? orientToTarget(cutPlane, effectivePlane.origin, directionVec as Vec3)
      : (directionVec as Vec3)
    const lineage = extrudeProfileWithLineage(
      oc,
      scope,
      allLoops,
      effectivePlane,
      sweepDir,
      length,
      firstSketchId,
      featureId,
    )
    toolShape = cutPlane !== null ? trimAtPlane(oc, scope, lineage.solid, cutPlane, sweepDir) : lineage.solid
    Object.assign(faceNames, lineage.faceNames)
    Object.assign(edgeNames, lineage.edgeNames)
    Object.assign(faceAncestry, lineage.faceAncestry)
    Object.assign(edgeAncestry, lineage.edgeAncestry)
  }

  // Editing handle: blind extrudes expose a draggable distance arrow anchored
  // at the profile centroid swept to the end face, so the grab point rides the
  // face the distance moves. Up-to extrudes have no distance to drag.
  if (termination !== 'up_to') {
    const grabDist = direction === 'symmetric' ? distance / 2 : distance
    let handleDir: number[] | null = null
    let handleBase: number[] | null = null
    if (usingFaces) {
      const n = faceNormal(oc, scope, cqFaces[0])
      handleDir = direction === 'reverse' ? (n.map((c) => -c) as Vec3) : n
      handleBase = faceCentroid(oc, scope, cqFaces[0])
    } else if (firstPt !== null && allLoops.length > 0) {
      const [dirVec] = resolveDirection((firstPt.normal as number[]) ?? [0, 0, 1], firstPt, direction, distance)
      handleDir = dirVec
      handleBase = sketchToWorld2d(loopCentroid(allLoops[0]), firstPt)
    }
    if (handleDir !== null && handleBase !== null) {
      const anchor = offsetAlong(handleBase, handleDir, grabDist)
      const handle = anchor === null
        ? null
        : linearHandle('distance', anchor, handleDir, distance, direction === 'symmetric' ? 0.5 : 1)
      if (handle !== null) result.handle = handle
    }
  }

  const opResult = applyBodyOperation(oc, scope, table, {
    toolShape,
    bodyStore,
    operation,
    mergeTarget,
    bodyId,
    featureId,
    sketchId: firstSketchId,
    opName: 'extrude',
    profileQueries,
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
