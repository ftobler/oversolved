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
import { AmbiguousQueryError } from '../query'
import { faceNormal, faceCentroid, makePrism, type Vec3 } from '../occ/primitives'
import { booleanWithHistory } from '../occ/booleans'
import { collectExtrudeLoops } from './faceProfile'
import { resolveDirection, registerTopFace, samePlane, surfaceEntityIds, sketchToWorld2d, unbuildableAreaReasons, type PlaneLike } from './shared'
import { loopCentroid } from '../profileLoops'
import { linearHandle, offsetAlong } from './featureHandles'
import { applyBodyOperation, type BodyOperation } from './bodyOps'
import { extrudeProfileWithLineage } from '../occ/prismLineage'
import { isEdgeProfileRef, resolveEdgeProfileFace } from './edgeProfile'
import { resolveUpToPlane, orientToTarget, trimAtPlane, UP_TO_REACH, type CutPlane } from './upTo'
import { faceGh } from '../occ/lineageHash'
import { nameNeighboursAndDeriveEdges } from '../occ/constructionLineage'

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

/**
 * Fuse a chain of prisms into one tool shape. Every consumed input (the
 * running result and each newly added prism) is tracked so a throw leaves it
 * to dispose(), and released once the next fuse has copied what it needs, so
 * re-solving a dirty feature does not stack dead intermediates on the heap.
 */
function fuseChain(
  oc: OccModule,
  scope: DisposeScope,
  first: OccShape,
  rest: OccShape[],
): OccShape {
  let tool = scope.track(first)
  for (const shape of rest) {
    const next = scope.track(shape)
    const fused = scope.track(fuse(oc, scope, tool, next))
    scope.release(tool)
    scope.release(next)
    tool = fused
  }
  return tool
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
  let firstSurfaces: Dict[] | undefined
  let firstPtData: PlaneLike | undefined
  const profileErrors: string[] = []
  const profileQueries: string[] = []
  const unbuildableReasons: string[] = []
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
      if (firstPt === null) {
        firstPt = resolved.plane
        firstSketchId = resolved.sketchId
        firstSurfaces = resolved.surfaces
        firstPtData = resolved.pt
      } else if (!samePlane(firstPt, resolved.plane)) {
        // Every loop below is lifted through firstPt's frame, so a second sketch
        // on a different plane would build its loops in the wrong place and
        // orientation; refuse it by name instead of building the wrong solid.
        // Face picks stay out of this guard: each face carries its own 3D frame,
        // and the mixed/coplanar guards below own them.
        throw new Error(
          `extrude: profile spans two different sketch planes ('${firstSketchId}' and ` +
          `'${resolved.sketchId}'); build one feature per plane`,
        )
      }
    }
    const topo = (globalRepo.elements.get('_topo_' + resolved.sketchId) as Dict | undefined) ?? {}
    // Why an area the user could see and pick will not build. Collected here
    // because this is the one place the sketch's areas are in hand; used only if
    // the profile ends up empty below.
    unbuildableReasons.push(...unbuildableAreaReasons((topo.surfaces as Dict[]) ?? []))
    for (const surface of (topo.surfaces as Dict[]) ?? []) {
      profileQueries.push(...surfaceEntityIds(surface))
    }
  }

  // All picked edges together bound one coplanar profile loop -> one face.
  if (edgeRefs.length > 0) {
    try {
      cqFaces.push(scope.track(resolveEdgeProfileFace(oc, scope, table, edgeRefs, bodyStore)))
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
    // Name the areas that failed the pre-flight gate. "no closed profile found"
    // is true but tells the user nothing they can act on; the stamped reason
    // names the joint and how wide it is.
    const why = unbuildableReasons.length ? ` (${unbuildableReasons.join('; ')})` : ''
    result.exception = `extrude: no closed profile found in the referenced sketch${why}; no part created`
    result.mesh_warning = 'no closed profile found; body has no shape'
    return result
  }

  if (cqFaces.length > 0 && allLoops.length > 0) {
    // Both were built; only one branch below can consume them, and the silent
    // drop reached applyBodyOperation with profile_queries naming geometry the
    // body does not contain. sweep.ts:459 refuses the same mix by name.
    throw new Error(
      'extrude: a profile mixing picked faces/edges with sketch areas is not supported; ' +
        'use one or the other',
    )
  }

  if (cqFaces.length > 1) {
    const n0 = faceNormal(oc, scope, cqFaces[0])
    const c0 = faceCentroid(oc, scope, cqFaces[0])
    for (let i = 1; i < cqFaces.length; i++) {
      const ni = faceNormal(oc, scope, cqFaces[i])
      const ci = faceCentroid(oc, scope, cqFaces[i])
      const dot = Math.abs(n0[0] * ni[0] + n0[1] * ni[1] + n0[2] * ni[2])
      const off = (ci[0] - c0[0]) * n0[0] + (ci[1] - c0[1]) * n0[1] + (ci[2] - c0[2]) * n0[2]
      if (Math.abs(dot - 1) > 1e-6 || Math.abs(off) > 1e-5) {
        // Every prism below is swept along face 0's normal, and an up_to target
        // is oriented from face 0's centroid alone: a face on another plane would
        // grow out of its own plane, or be trimmed to nothing.
        throw new Error(
          'extrude: picked faces are not coplanar; extrude them one plane at a time',
        )
      }
    }
  }

  // Up-to termination: resolve the cut plane once, using a representative extrude
  // direction so a point target can take the extrude direction as its normal.
  const termination = (merged.termination as string) ?? 'blind'
  const upToRef = (merged.up_to as string) ?? ''
  const usingFaces = cqFaces.length > 0 && allLoops.length === 0
  // One BRepAdaptor_Surface + BRepLProp_SLProps for the whole solve. Lazy, not
  // eager: faceNormal throws when the UV-midpoint normal is undefined
  // (primitives.ts:601), and only the branches that reach it today may throw.
  let faceNormal0: Vec3 | null = null
  const profileNormal = (): Vec3 => (faceNormal0 ??= faceNormal(oc, scope, cqFaces[0]))
  let cutPlane: CutPlane | null = null
  if (termination === 'up_to' && upToRef) {
    if (direction === 'symmetric') {
      throw new Error('extrude up_to: symmetric direction is not supported')
    }
    const probeDir: Vec3 = usingFaces
      ? (direction === 'reverse'
          ? (profileNormal().map((n) => -n) as Vec3)
          : (profileNormal() as Vec3))
      : (resolveDirection((firstPt?.normal as number[]) ?? [0, 0, 1], firstPt as PlaneLike, direction, distance)[0] as Vec3)
    try {
      cutPlane = resolveUpToPlane(oc, scope, table, upToRef, probeDir, globalRepo, bodyStore)
    } catch (e) {
      // Ambiguity degrades to blind distance with a warning naming it; every
      // other error (non-planar target, kernel failures) stays a loud feature
      // failure exactly as before.
      if (!(e instanceof AmbiguousQueryError)) throw e
      result.solver_warning =
        `extrude: up_to target '${upToRef}' matched several elements (${e instanceof Error ? e.message : String(e)}); used blind distance`
    }
    if (cutPlane === null && result.solver_warning === undefined) {
      result.solver_warning = `extrude: up_to target '${upToRef}' did not resolve; used blind distance`
    }
  }

  let toolShape: OccShape
  if (usingFaces) {
    const faceNormalVec = profileNormal()
    const reverseVec = faceNormalVec.map((n) => -n) as Vec3
    if (cutPlane !== null) {
      const nominal = (direction === 'reverse' ? reverseVec : faceNormalVec) as Vec3
      const dirVec = orientToTarget(cutPlane, faceCentroid(oc, scope, cqFaces[0]), nominal)
      const tool = fuseChain(
        oc, scope,
        scope.track(makePrism(oc, scope, cqFaces[0], dirVec, UP_TO_REACH)),
        cqFaces.slice(1).map((f) => scope.track(makePrism(oc, scope, f, dirVec, UP_TO_REACH))),
      )
      // The trim's Common consumes the over-length prism.
      toolShape = scope.track(trimAtPlane(oc, scope, tool, cutPlane, dirVec))
      scope.release(tool)
    } else if (direction === 'symmetric') {
      const half = distance / 2.0
      // Pair-first order preserved from the pre-disposal version: both halves
      // of a face fuse together, then into the running tool.
      const halfPair = (f: OccShape): OccShape => {
        const pos = scope.track(makePrism(oc, scope, f, faceNormalVec, half))
        const neg = scope.track(makePrism(oc, scope, f, reverseVec, half))
        const pair = scope.track(fuse(oc, scope, pos, neg))
        scope.release(pos)
        scope.release(neg)
        return pair
      }
      let tool = scope.track(halfPair(cqFaces[0]))
      for (const f of cqFaces.slice(1)) {
        const pair = scope.track(halfPair(f))
        const fused = scope.track(fuse(oc, scope, tool, pair))
        scope.release(tool)
        scope.release(pair)
        tool = fused
      }
      toolShape = tool
    } else if (direction === 'reverse') {
      toolShape = fuseChain(
        oc, scope,
        scope.track(makePrism(oc, scope, cqFaces[0], reverseVec, distance)),
        cqFaces.slice(1).map((f) => scope.track(makePrism(oc, scope, f, reverseVec, distance))),
      )
    } else {
      toolShape = fuseChain(
        oc, scope,
        scope.track(makePrism(oc, scope, cqFaces[0], faceNormalVec, distance)),
        cqFaces.slice(1).map((f) => scope.track(makePrism(oc, scope, f, faceNormalVec, distance))),
      )
    }
    // Seed face names from the source body so nameFacesFromNeighbours can
    // propagate to the rest of the tool solid's faces.
    const seedGh = faceGh(oc, scope, cqFaces[0])
    for (const body of Object.values(bodyStore)) {
      const fn = body.face_names
      if (fn && seedGh in fn) {
        faceNames[seedGh] = fn[seedGh]
        const fa = body.face_ancestry
        if (fa) faceAncestry[fn[seedGh]] = fa[fn[seedGh]] ?? []
        break
      }
    }
    const edgeResult = nameNeighboursAndDeriveEdges(oc, scope, toolShape, faceNames, faceAncestry)
    Object.assign(edgeNames, edgeResult.edgeNames)
    Object.assign(edgeAncestry, edgeResult.edgeAncestry)
  } else {
    const normal = (firstPt?.normal as number[]) ?? [0, 0, 1]
    const [directionVec, effectiveDistance, effectivePlane] = resolveDirection(
      normal,
      firstPt as PlaneLike,
      direction,
      distance,
    )
    // Register the top face with the effective distance (after direction
    // resolution) so reverse/symmetric extrudes place it correctly.
    if (firstSurfaces !== undefined && firstPtData !== undefined) {
      registerTopFace(globalRepo, featureId, firstPtData, firstSurfaces, effectiveDistance)
    }
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
    // The tool is scope-owned from here: applyBodyOperation detaches whatever
    // becomes a body, and the leftover (an add/cut tool, a compound wrapper)
    // frees at dispose instead of living for the worker session.
    const swept = scope.track(lineage.solid)
    if (cutPlane !== null) {
      // The trim's Common consumes the over-length sweep.
      toolShape = scope.track(trimAtPlane(oc, scope, swept, cutPlane, sweepDir))
      scope.release(swept)
    } else {
      toolShape = swept
    }
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
      const n = profileNormal()
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
