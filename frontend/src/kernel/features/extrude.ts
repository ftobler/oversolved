// The extrude leaf, the simplest brep producer and the first phase-2f feature. It resolves each
// profile reference to 2D loops (or a body face), builds the tool solid with per-entity
// lineage, and applies the body operation (add / cut / new).
//
// This is the wiring layer: collectExtrudeLoops (faceProfile.ts), resolveDirection
// (shared/directionQuery.ts),
// extrudeProfileWithLineage (occ/prismLineage.ts), and applyBodyOperation (bodyOps.ts) do the
// work. Like every OCC-backed leaf it takes (oc, scope, table) ahead of the Python (feature,
// globalRepo, bodyStore) signature; the caller owns `scope` and disposes it after ancestry
// registration.

import type { DisposeScope } from '../occ/disposeScope'
import { extractErrorMessage } from '../errors'
import type { OccModule, OccPrismBuilder, OccShape, OccSubShape } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'
import type { Repository } from '../query'
import { AmbiguousQueryError } from '../query'
import { faceNormal, faceCentroid, type Vec3 } from '../occ/primitives'
import { booleanWithHistory, shapesIntersect, shapesTouch } from '../occ/booleans'
import { collectExtrudeLoops } from './faceProfile'
import { resolveDirection } from './shared/directionQuery'
import { registerTopFace } from './shared/topFace'
import { samePlane, sketchToWorld2d, type PlaneLike } from './shared/planes'
import { resolveBodyIds } from './shared/bodyResolution'
import { bodyFrame, projectedRadius } from './shared/bodyExtent'
import { surfaceEntityIds } from './shared/bodyRef'
import { openJointHint, profileAreaReport } from './shared/profileLoops'
import { loopCentroid } from '../profileLoops'
import { linearHandle, offsetAlong } from './featureHandles'
import { applyBodyOperation, type BodyOperation } from './bodyOps'
import { makeTranslationTrsf, transformCopy } from '../occ/transforms'
import { extrudeProfileWithLineage } from '../occ/prismLineage'
import { isEdgeProfileRef, resolveEdgeProfileFace } from './edgeProfile'
import { resolveUpToPlane, orientToTarget, trimAtPlane, UP_TO_REACH, type CutPlane } from './upTo'
import { deriveEdgeNames, nameNeighboursAndDeriveEdges } from '../occ/constructionLineage'
import {
  canonicalFaces, canonicalIndex, carryFaceNames, emptyShapeNames, mergeShapeNames,
} from '../occ/bodyNames'
import { swallowUnlessTrap } from '../errors'

type Dict = Record<string, unknown>

interface ExtrudeResult {
  [key: string]: unknown
  status: string
  body_id: string
  // Every body the operation produced; `body_id` is just the first (features/bodySplit.ts).
  body_ids?: string[]
}

/**
 * Fuse a chain of prisms into one tool shape with `join`. Every consumed input
 * (the running result and each newly added prism) is tracked so a throw leaves
 * it to dispose(), and released once the next fuse has copied what it needs, so
 * re-solving a dirty feature does not stack dead intermediates on the heap.
 */
function fuseChain(
  scope: DisposeScope,
  first: OccShape,
  rest: OccShape[],
  join: (a: OccShape, b: OccShape) => OccShape,
): OccShape {
  let tool = scope.track(first)
  for (const shape of rest) {
    const next = scope.track(shape)
    const fused = scope.track(join(tool, next))
    scope.release(tool)
    scope.release(next)
    tool = fused
  }
  return tool
}

/**
 * The construction name a body gives `face` (one of its own faces, as a face
 * profile pick resolves it), with its ancestry; null when no body names it.
 */
function bodyFaceName(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  bodyStore: Record<string, Body>,
  face: OccShape,
): { uuid: string; ancestry: string[] } | null {
  for (const body of Object.values(bodyStore)) {
    if (body.shape === null || body.face_uuids === undefined) continue
    const at = canonicalIndex(canonicalFaces(oc, scope, table.get<OccShape>(body.shape))).get(face as OccSubShape)
    if (at < 0) continue
    const uuid = body.face_uuids[at]
    return uuid ? { uuid, ancestry: [...(body.face_ancestry?.[uuid] ?? [])] } : null
  }
  return null
}

/**
 * The opposite-direction probe a missed cut runs (bodyOps): the tool moved back
 * by its own sweep spans the profile minus [0, sweep], which is exactly the
 * prism the other `direction` builds. Built only when the cut missed.
 */
function oppositeCutProbe(
  oc: OccModule,
  scope: DisposeScope,
  tool: OccShape,
  sweep: Vec3,
  direction: string,
): { tool: () => OccShape | null; message: string } {
  const other = direction === 'reverse' ? 'normal' : 'reverse'
  const along = direction === 'reverse' ? 'against' : 'along'
  return {
    tool: () => {
      try {
        const back = makeTranslationTrsf(oc, scope, -sweep[0], -sweep[1], -sweep[2])
        return scope.track(transformCopy(oc, scope, tool, back))
      } catch (e) {
        swallowUnlessTrap(e)
        return null  // a failed probe only loses the hint; the plain miss error still fires
      }
    },
    message: `cutting ${along} the plane normal leaves the body; \`direction: ${other}\` cuts into it`,
  }
}

/**
 * The pattern leaf re-solves a cut source with its operation forced to `new` in
 * an empty scratch store, to hand the tool back for its copies. A through_all
 * source cannot size its tool from that scratch store, and the forced operation
 * is not the one the termination describes, so the caller states the authored
 * operation and the bodies the copies will cut.
 */
export interface ThroughAllSource {
  operation: 'add' | 'cut'
  bodies: Record<string, Body>
}

/** The solve-context slot the pattern leaf's internal through_all tool build
 *  fills. Every other caller leaves the through_all source out; the registry's
 *  variable context rides the same slot, so its two keys are named here to keep
 *  the shared context type assignable. extrude reads only the source. */
interface ExtrudeSolveContext {
  variables?: Record<string, number>
  laterVariables?: Record<string, number>
  throughAllSource?: ThroughAllSource
}

/** Normalize a plane normal or face normal for an AABB projection. */
function unitDirection(v: number[]): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2])
  if (!(length > 1e-12)) throw new Error('extrude: through_all needs a sweep direction')
  return [v[0] / length, v[1] / length, v[2] / length]
}

/** The reach a through-all cut needs, measured from the profile plane: the
 *  signed distance to the far material extent ahead and behind it along the
 *  sweep direction, plus the union span of both for the one-sided directions.
 *  A plane outside the material makes the side beyond it negative. */
interface ThroughAllExtent {
  ahead: number
  behind: number
  span: number
}

/**
 * The reach a through-all cut must sweep from the profile plane: the union of
 * the chosen bodies' edge-sampled AABBs projected onto the unit sweep
 * direction, measured on each side of `origin` (a point on the profile plane)
 * and widened by the hole's own relative margin (`span * 1e-3 + 1e-6`) per
 * side. `merge_target` narrows the measurement to the bodies it names; when it
 * names no live body the whole store is measured and the body operation refuses
 * the bad target afterwards.
 *
 * Symmetric needs both sides because the plane can sit anywhere inside the
 * bodies, including outside them; one length measured from the union span only
 * clears the material when the plane happens to be at the span's midpoint.
 *
 * A body far away along the same axis inflates the tool. That is harmless for a
 * cut because the extra length sits outside material, so do not add a lateral
 * test here: it could silently under-size the tool.
 */
function throughAllSweepExtent(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  bodyStore: Record<string, Body>,
  mergeTarget: string | null,
  direction: Vec3,
  origin: Vec3,
): ThroughAllExtent {
  const targeted = mergeTarget ? resolveBodyIds(mergeTarget, bodyStore) : []
  const ids = targeted.length > 0 ? targeted : Object.keys(bodyStore)
  let min = Infinity
  let max = -Infinity
  let measured = 0
  for (const id of ids) {
    const body = bodyStore[id]
    if (body === undefined || body.shape === null) continue
    const frame = bodyFrame(oc, scope, table.get<OccShape>(body.shape))
    const centre = frame.center[0] * direction[0] + frame.center[1] * direction[1] + frame.center[2] * direction[2]
    const radius = projectedRadius(frame, direction)
    min = Math.min(min, centre - radius)
    max = Math.max(max, centre + radius)
    measured++
  }
  if (measured === 0) {
    throw new Error(
      'extrude: through_all needs a body to cut through; name merge_target or build the body first',
    )
  }
  const span = max - min
  const margin = span * 1e-3 + 1e-6
  const at = origin[0] * direction[0] + origin[1] * direction[1] + origin[2] * direction[2]
  return {
    ahead: max - at + margin,
    behind: at - min + margin,
    span: span + margin,
  }
}

/** Solve an extrude feature into the body store (mirrors `_solve_extrude`). */
export function solveExtrude(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
  // The dispatch contract's two trailing slots: `featuresById` for the leaves
  // that resolve other features, and the variable context for the ones that
  // re-solve them. extrude reads neither (the slot is typed `unknown` so the
  // ignored record does not re-add a loose feature shape to the ratchet), but
  // the through_all tool build uses the context slot, so the arity stays the
  // registry's.
  _featuresById?: unknown,
  solveContext?: ExtrudeSolveContext,
): ExtrudeResult {
  const throughAllSource = solveContext?.throughAllSource
  const featureId = (feature.id as string) ?? ''
  const sub = (feature.extrude as Dict) ?? {}
  const mergeTarget = (sub.merge_target as string) ?? null

  const sketchRaw = sub.sketch
  const sketchRefs: string[] = Array.isArray(sketchRaw)
    ? (sketchRaw as string[]).filter((s) => s)
    : sketchRaw
      ? [sketchRaw as string]
      : []
  // Nullish, not truthy: an explicit distance=0 must survive to the non-zero
  // validation below instead of silently becoming the default depth.
  const distance = Number(
    (sub.distance as number | null | undefined) ?? (sub.depth as number | null | undefined) ?? 1.0,
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
  // Accounting for the partial-profile report: the referenced areas and how
  // many of them produced a loop. Only the areas the reference NAMES count, so
  // a broken area elsewhere in a picked sketch does not turn this feature
  // partial.
  let areaTotal = 0
  let areaBuilt = 0
  // The tool's construction names, keyed by the faces and edges of the tool.
  const names = emptyShapeNames()

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
      swallowUnlessTrap(exc)
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
    // Why an area the user could see and pick did not build. Scoped to the
    // areas this reference names: an unpicked area is not unbuildable. The
    // profile handoff's own refusals (a boundary that never closed or left
    // edges behind) fold in through the same report.
    const report = profileAreaReport(
      resolved.profileSurfaces ?? [],
      resolved.builtSurfaces,
      resolved.loopDiags ?? [],
    )
    areaTotal += report.total
    areaBuilt += report.built
    if (report.total === 0) {
      const hint = openJointHint(
        (topo.edges as Dict[]) ?? [],
        (topo.unmet_contacts as Dict[]) ?? [],
      )
      if (hint !== null && !unbuildableReasons.includes(hint)) unbuildableReasons.push(hint)
    }
    for (const reason of report.reasons) {
      if (!unbuildableReasons.includes(reason)) unbuildableReasons.push(reason)
    }
    for (const surface of (topo.surfaces as Dict[]) ?? []) {
      profileQueries.push(...surfaceEntityIds(surface))
    }
  }

  // All picked edges together bound one coplanar profile loop -> one face.
  if (edgeRefs.length > 0) {
    try {
      cqFaces.push(scope.track(resolveEdgeProfileFace(oc, scope, table, edgeRefs, bodyStore)))
    } catch (exc) {
      swallowUnlessTrap(exc)
      profileErrors.push(extractErrorMessage(exc))
    }
  }

  if (profileErrors.length && cqFaces.length === 0 && allLoops.length === 0) {
    throw new Error(profileErrors.join('; '))
  }

  const bodyId = 'body_' + featureId
  const result: ExtrudeResult = { status: 'ok', body_id: bodyId }
  const operation = ((sub.operation as string) ?? 'add') as BodyOperation
  const direction = (sub.direction as string) ?? 'normal'

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
    // body does not contain. sweep's mixed-profile guard refuses the same mix by name.
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
  const termination = (sub.termination as string) ?? 'blind'
  // A through-all tool is sized from the bodies it cuts, which is meaningless
  // for a tool that adds material or intersects it. The pattern leaf's internal
  // tool build passes the authored operation because it forces `new` to get the
  // tool back; every authored solve judges its own operation.
  const terminationOperation = throughAllSource?.operation ?? operation
  if (termination === 'through_all' && terminationOperation !== 'cut') {
    throw new Error(
      `extrude: through_all is a cut termination, but operation is ${terminationOperation}; ` +
        'set operation: cut, or use termination: blind or up_to',
    )
  }
  const upToRef = (sub.up_to as string) ?? ''
  const usingFaces = cqFaces.length > 0 && allLoops.length === 0
  // One BRepAdaptor_Surface + BRepLProp_SLProps for the whole solve. Lazy, not
  // eager: faceNormal throws when the UV-midpoint normal is undefined (see
  // `faceNormal` in occ/primitives.ts), and only the branches that reach it
  // today may throw.
  let faceNormal0: Vec3 | null = null
  const profileNormal = (): Vec3 => (faceNormal0 ??= faceNormal(oc, scope, cqFaces[0]))
  let cutPlane: CutPlane | null = null
  // The up-to fallback note is held until after the body operation runs, so a
  // body-op warning cannot overwrite it (applyBodyOperation assigns its own).
  let upToWarning: string | undefined
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
      upToWarning =
        `extrude: up_to target '${upToRef}' matched several elements (${e instanceof Error ? e.message : String(e)}); used blind distance`
    }
    if (cutPlane === null && upToWarning === undefined) {
      upToWarning = `extrude: up_to target '${upToRef}' did not resolve; used blind distance`
    }
  } else if (termination === 'up_to') {
    // The staged editor hides `distance` while termination is up_to, but a
    // script may still publish the state before it picks a target. Silence
    // here read as an up-to that ignored its distance; name the fallback.
    upToWarning = 'extrude: up_to has no target; used blind distance'
  }

  // A through-all cut is sized from the bodies, not from the stored `distance`,
  // and measured from the profile plane. Normal and reverse stay one-sided and
  // sweep the union span ahead of the plane; symmetric is both-sided, so it
  // straddles the plane by the larger of the reach ahead and behind. Sizing by
  // the union span alone under-cuts symmetric whenever the plane is off-centre.
  let sweepDistance = distance
  if (termination === 'through_all') {
    const frameNormal: Vec3 = usingFaces
      ? profileNormal()
      : (((firstPt?.normal as number[]) ?? [0, 0, 1]) as Vec3)
    const sweepDir = direction === 'reverse'
      ? (frameNormal.map((n) => -n) as Vec3)
      : frameNormal
    const planeOrigin: Vec3 = usingFaces
      ? faceCentroid(oc, scope, cqFaces[0])
      : (((firstPt?.origin as number[] | undefined) ?? [0, 0, 0]) as Vec3)
    const extent = throughAllSweepExtent(
      oc,
      scope,
      table,
      throughAllSource?.bodies ?? bodyStore,
      mergeTarget,
      unitDirection(sweepDir),
      planeOrigin,
    )
    sweepDistance = direction === 'symmetric'
      ? 2 * Math.max(extent.ahead, extent.behind)
      : extent.span
  }

  let toolShape: OccShape
  // The blind one-sided sweep, distance included: the tool spans the profile
  // plus [0, sweep]. Set only on the plain normal/reverse branches, the ones a
  // cut that misses can be flipped on.
  let sweep: Vec3 | null = null
  if (usingFaces) {
    const faceNormalVec = profileNormal()
    const reverseVec = faceNormalVec.map((n) => -n) as Vec3
    // The picked face's own name, when a body names it, seeds the tool: it goes
    // on the prism cap copied from that face, rides every fuse and the up-to
    // trim by their face history, and the neighbour pass below names the rest
    // of the tool from it.
    const seed = bodyFaceName(oc, scope, table, bodyStore, cqFaces[0])
    if (seed !== null) names.faceAncestry[seed.uuid] = seed.ancestry
    const prism = (face: OccShape, dir: Vec3, length: number, seeded: boolean): OccShape => {
      const vec = scope.track(new oc.gp_Vec_4(dir[0] * length, dir[1] * length, dir[2] * length))
      const builder = scope.track(new oc.BRepPrimAPI_MakePrism_1(face, vec, true, true)) as OccPrismBuilder
      const cap = seeded && seed !== null ? builder.FirstShape?.() : undefined
      if (cap !== undefined) names.faceNames.set(scope.track(cap) as OccSubShape, seed!.uuid)
      return builder.Shape()
    }
    const fuse = (a: OccShape, b: OccShape): OccShape => {
      const r = booleanWithHistory(oc, scope, a, b, 'fuse')
      names.faceNames = carryFaceNames(r.faceOrigin, names.faceNames, names.faceNames)
      return r.shape
    }
    if (cutPlane !== null) {
      const nominal = (direction === 'reverse' ? reverseVec : faceNormalVec) as Vec3
      const dirVec = orientToTarget(cutPlane, faceCentroid(oc, scope, cqFaces[0]), nominal)
      const tool = fuseChain(
        scope,
        scope.track(prism(cqFaces[0], dirVec, UP_TO_REACH, true)),
        cqFaces.slice(1).map((f) => scope.track(prism(f, dirVec, UP_TO_REACH, false))),
        fuse,
      )
      // The trim's Common consumes the over-length prism.
      const trimmed = trimAtPlane(oc, scope, tool, cutPlane, dirVec)
      toolShape = scope.track(trimmed.shape)
      names.faceNames = carryFaceNames(trimmed.faceOrigin, names.faceNames, null)
      scope.release(tool)
    } else if (direction === 'symmetric') {
      const half = sweepDistance / 2.0
      // Pair-first order preserved from the pre-disposal version: both halves
      // of a face fuse together, then into the running tool. Both halves' caps
      // sit inside the pair, so neither is seeded.
      const halfPair = (f: OccShape): OccShape => {
        const pos = scope.track(prism(f, faceNormalVec, half, false))
        const neg = scope.track(prism(f, reverseVec, half, false))
        const pair = scope.track(fuse(pos, neg))
        scope.release(pos)
        scope.release(neg)
        return pair
      }
      let tool = scope.track(halfPair(cqFaces[0]))
      for (const f of cqFaces.slice(1)) {
        const pair = scope.track(halfPair(f))
        const fused = scope.track(fuse(tool, pair))
        scope.release(tool)
        scope.release(pair)
        tool = fused
      }
      toolShape = tool
    } else {
      const dir = direction === 'reverse' ? reverseVec : faceNormalVec
      sweep = dir.map((c) => c * sweepDistance) as Vec3
      toolShape = fuseChain(
        scope,
        scope.track(prism(cqFaces[0], dir, sweepDistance, true)),
        cqFaces.slice(1).map((f) => scope.track(prism(f, dir, sweepDistance, false))),
        fuse,
      )
    }
    const edgeResult = nameNeighboursAndDeriveEdges(oc, scope, toolShape, names.faceNames, names.faceAncestry)
    names.edgeNames = edgeResult.edgeNames
    Object.assign(names.edgeAncestry, edgeResult.edgeAncestry)
  } else {
    const normal = (firstPt?.normal as number[]) ?? [0, 0, 1]
    const [directionVec, effectiveDistance, effectivePlane] = resolveDirection(
      normal,
      firstPt as PlaneLike,
      direction,
      sweepDistance,
    )
    // Register the top face with the effective distance (after direction
    // resolution) so reverse/symmetric extrudes place it correctly. A
    // through-all cut has no authored end, so there is no honest frame to
    // register at the ignored distance.
    if (termination !== 'through_all' && firstSurfaces !== undefined && firstPtData !== undefined) {
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
    mergeShapeNames(names, lineage)
    if (cutPlane !== null) {
      // The trim's Common consumes the over-length sweep. Its face history
      // carries the sweep's names onto the trimmed faces, and the edges are
      // derived again on the trimmed solid.
      const trimmed = trimAtPlane(oc, scope, swept, cutPlane, sweepDir)
      toolShape = scope.track(trimmed.shape)
      scope.release(swept)
      names.faceNames = carryFaceNames(trimmed.faceOrigin, names.faceNames, null)
      const edges = deriveEdgeNames(oc, scope, toolShape, names.faceNames, names.faceAncestry)
      names.edgeNames = edges.edgeNames
      Object.assign(names.edgeAncestry, edges.edgeAncestry)
    } else {
      toolShape = swept
      if (direction !== 'symmetric') sweep = sweepDir.map((c) => c * length) as Vec3
    }
  }

  // Editing handle: blind extrudes expose a draggable distance arrow anchored
  // at the profile centroid swept to the end face, so the grab point rides the
  // face the distance moves. Up-to and through-all have no authored distance to
  // drag (through-all's length belongs to the bodies, not to the field).
  if (termination === 'blind') {
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
    faceNames: names.faceNames,
    edgeNames: names.edgeNames,
    faceAncestry: names.faceAncestry,
    edgeAncestry: names.edgeAncestry,
    capAncestry: names.capAncestry,
    // An add extends the part; a profile that reaches no existing body is a
    // misplaced sketch, not a second part. `operation: new` is the way to start
    // one, and it is the only way (an add mints nothing).
    addRequiresExisting: operation === 'add',
    ...(operation === 'cut' && sweep !== null && { oppositeProbe: oppositeCutProbe(oc, scope, toolShape, sweep, direction) }),
  })
  Object.assign(result, opResult)

  // The body operation may have written its own warning (a no-op cut/add).
  // Compose rather than assign so the up-to fallback is not lost.
  if (upToWarning !== undefined) {
    result.solver_warning = result.solver_warning === undefined
      ? upToWarning
      : `${upToWarning}; ${result.solver_warning}`
  }

  // An add with no explicit merge target fuses into the FIRST body it connects
  // to and then stops. When the new solid also reaches another body, that body
  // stays separate: silently, before this check, the caller saw one fused body
  // and a second one it did not ask for. Name it and the one-step fix rather
  // than widening the operation here (user decision: warn now, fuse-all later).
  // "Reaches" needs both probes: the Common sees an overlap or a fully enclosed
  // body, the distance probe sees a body only a shared face connects.
  if (operation === 'add' && !mergeTarget && opResult.body_id !== bodyId) {
    const touched: string[] = []
    for (const otherId of Object.keys(bodyStore).sort()) {
      if (otherId === opResult.body_id || (opResult.body_ids ?? []).includes(otherId)) continue
      const other = bodyStore[otherId]
      if (other.shape === null) continue
      const otherShape = table.get<OccShape>(other.shape)
      if (shapesIntersect(oc, otherShape, toolShape) || shapesTouch(oc, otherShape, toolShape)) {
        touched.push(otherId)
      }
    }
    if (touched.length > 0) {
      const warning = `extrude: the new solid also touches ${touched.join(', ')}; add a boolean union to fuse it`
      result.solver_warning = result.solver_warning === undefined
        ? warning
        : `${result.solver_warning}; ${warning}`
    }
  }

  if (profileErrors.length) {
    result.status = 'partial'
    result.exception = profileErrors.join('; ')
  }
  if (unbuildableReasons.length > 0) {
    // Some referenced area did not build while the rest did. That is a partial
    // profile, not an ok one: the tool is missing geometry the user drew and
    // can see. Same convention as a partial fillet or a hole that missed some
    // sites. Only reached with a non-empty profile (the empty case returned
    // above with the "no closed profile found" error).
    result.status = 'partial'
    const message =
      `extrude: built ${areaBuilt} of ${areaTotal} profile areas; ` +
      unbuildableReasons.join('; ')
    result.exception = result.exception === undefined ? message : `${result.exception}; ${message}`
  }

  return result
}
