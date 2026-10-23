// The revolve leaf, analogous to extrude but sweeping each profile around an axis. It resolves
// each profile to 2D loops (or a body face), resolves the revolve axis from its required `axis`
// pick, builds the tool solid with per-entity lineage, and applies the body operation. An
// axis-less revolve is a solve error, never a revolve about a default axis -- see
// resolveRevolveAxis.

import type { DisposeScope } from '../occ/disposeScope'
import { extractErrorMessage } from '../errors'
import type { OccModule, OccShape } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'
import type { Repository } from '../query'
import { booleanWithHistory } from '../occ/booleans'
import { collectExtrudeLoops } from './faceProfile'
import { samePlane, sketchToWorld2d, type PlaneLike } from './shared/planes'
import { surfaceEntityIds } from './shared/bodyRef'
import { unbuildableAreaReasons, loopDiagReasons } from './shared/profileLoops'
import { applyBodyOperation, type BodyOperation } from './bodyOps'
import { revolveFace, revolveProfileWithLineage } from '../occ/prismLineage'
import { carryFaceNames, emptyShapeNames, mergeShapeNames } from '../occ/bodyNames'
import { deriveEdgeNames } from '../occ/constructionLineage'
import { faceCentroid, type Vec3 } from '../occ/primitives'
import { loopCentroid, loopPts, pointInLoop } from '../profileLoops'
import { angularHandle } from './featureHandles'

type Dict = Record<string, unknown>

interface RevolveResult {
  [key: string]: unknown
  status: string
  body_id: string
  // Every body the operation produced; `body_id` is just the first (features/bodySplit.ts).
  body_ids?: string[]
}

function fuse(oc: OccModule, scope: DisposeScope, a: OccShape, b: OccShape): OccShape {
  return booleanWithHistory(oc, scope, a, b, 'fuse').shape
}

// Track a freshly built revolve solid so a throw leaves it to dispose(); the
// caller releases it once a fuse has consumed it (see fuseConsuming).
function trackedRevolveFace(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  ao: Vec3,
  ad: Vec3,
  angleDeg: number,
): OccShape {
  return scope.track(revolveFace(oc, scope, face, ao, ad, angleDeg))
}

// Fuse `b` into tracked `a`, release both consumed inputs, return the tracked
// fused result. Keeps repeated edits of one feature from stacking dead solids.
function fuseConsuming(
  oc: OccModule,
  scope: DisposeScope,
  a: OccShape,
  b: OccShape,
): OccShape {
  const bt = scope.track(b)
  const fused = scope.track(fuse(oc, scope, a, bt))
  scope.release(a)
  scope.release(bt)
  return fused
}

/**
 * Resolve the revolve axis from its `axis` pick (mirrors the inline block in
 * `_solve_revolve`): a line edge or sketch line gives start -> end, a circular
 * edge gives its center and plane normal. The pick's own orientation is the
 * sweep sense; `direction: reverse` is how the user flips it.
 *
 * The pick is REQUIRED and is the only axis input. There is no default axis and
 * no stored `axis_origin` / `axis_direction` alternative: a revolve about world
 * Z (or any other stored vector) silently produced a plausible-looking wrong
 * solid for a user who never picked an axis. Same contract as the
 * circular-array leaf (`circular_array: axis is required`).
 *
 * Fail-loud guards: when the pick is set but the registry returns null (stale
 * pick -- the body rebuild minted new ancestry tokens, the edge was deleted, or
 * the sketch line was removed), OR when the resolved payload carries no usable
 * axis geometry (a degenerate line, a missing sketch plane, or an unrecognised
 * shape), the resolver throws so the revolve surfaces as a red feature and the
 * user re-picks the axis. Mirrors the rotation-axis guard in transformMirror
 * (`transform: rotation_axis not found`).
 */
export function resolveRevolveAxis(
  feature: Dict,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
): [number[], number[]] {
  const axisQuery = (feature.axis as string | undefined) || undefined
  if (!axisQuery) {
    throw new Error('revolve: axis is required; pick an edge, sketch line, or circular edge')
  }

  const axisData = globalRepo.query(axisQuery, null, bodyStore) as Dict | null
  if (axisData === null) {
    throw new Error(`revolve: axis query did not resolve: ${JSON.stringify(axisQuery)}`)
  }

  const fromLine = (start: number[], end: number[]): [number[], number[]] | null => {
    const dx = end[0] - start[0]
    const dy = end[1] - start[1]
    const dz = end[2] - start[2]
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (length <= 1e-12) return null
    return [[...start], [dx / length, dy / length, dz / length]]
  }

  // Each branch yields null when its payload is degenerate (a zero-length line
  // or circle normal, a sketch line whose plane is gone); the throw below turns
  // that into a red feature rather than a revolve about some leftover axis.
  let axis: [number[], number[]] | null = null
  if ('start' in axisData && 'end' in axisData) {
    axis = fromLine(axisData.start as number[], axisData.end as number[])
  } else if ('center' in axisData && 'axis' in axisData) {
    // Circle / arc / ellipse edge: the center sits on the rotation axis and the
    // axis field (the circle's plane normal) is the rotation direction.
    const raw = axisData.axis as number[]
    const axLen = Math.sqrt(raw[0] * raw[0] + raw[1] * raw[1] + raw[2] * raw[2])
    if (axLen > 1e-12) {
      axis = [[...(axisData.center as number[])], [raw[0] / axLen, raw[1] / axLen, raw[2] / axLen]]
    }
  } else if ('external_params' in axisData && axisData.kind === 'line') {
    const sketchId = (axisData.sketch_id as string) ?? ''
    const plane = sketchId ? (globalRepo.elements.get('_pt_' + sketchId) as PlaneLike | undefined) : undefined
    if (plane) {
      const params = axisData.external_params as number[]
      axis = fromLine(sketchToWorld2d(params.slice(0, 2), plane), sketchToWorld2d(params.slice(2, 4), plane))
    }
  }

  if (axis === null) {
    throw new Error(
      'revolve: resolved axis payload carries no usable axis ' +
        `(missing start/end, center/axis, or external_params+sketch plane for): ${JSON.stringify(axisQuery)}`,
    )
  }
  return axis
}

/**
 * Refuse an axis that cuts through the interior of a profile loop.
 *
 * OCC's MakeRevol either refuses such a profile or builds a self-intersecting
 * solid, both reported as a bare "builder did not complete". The axis is legal
 * when it touches the boundary (a tangent, or a line along an edge): only a
 * line with loop vertices strictly on both sides cuts through. The axis is
 * mapped into the sketch frame first, so an axis parallel to the plane is
 * tested as its in-plane projection and a skew axis by its one point where it
 * meets the plane. Loops are the assembled boundaries, so a hole's boundary is
 * checked too: material revolved around an axis inside its own hole would
 * sweep through itself.
 */
export function refuseAxisThroughProfile(
  loops: Dict[][],
  plane: PlaneLike,
  axisOrigin: number[],
  axisDirection: number[],
  areaId: string,
): void {
  const dot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const to2d = (p: number[]): number[] => {
    const rel = [p[0] - plane.origin[0], p[1] - plane.origin[1], p[2] - plane.origin[2]]
    return [dot(rel, plane.x_axis), dot(rel, plane.y_axis)]
  }
  const normalComponent = dot(axisDirection, plane.normal)
  // Below this the direction counts as lying in the plane; a normalised vector
  // has an in-plane component near 1 when its normal component is this small.
  const PARALLEL_EPS = 1e-9
  const fail = (): never => {
    throw new Error(
      `revolve: the axis crosses profile area ${areaId}; ` +
      'a revolve axis may touch the profile but not cut through it',
    )
  }

  for (const loop of loops) {
    const pts = loopPts(loop, 16)
    if (pts.length < 3) continue
    if (Math.abs(normalComponent) <= PARALLEL_EPS) {
      const origin2 = to2d(axisOrigin)
      const dir2 = [
        dot(axisDirection, plane.x_axis),
        dot(axisDirection, plane.y_axis),
      ]
      const len = Math.hypot(dir2[0], dir2[1])
      if (len <= PARALLEL_EPS) continue
      // Signed distance of every polygon vertex from the projected line. A
      // vertex on the line is a touch; strictly opposite signs mean the line
      // runs through the loop's interior. The tolerance scales with the loop so
      // far-from-origin sketches are not dominated by rounding.
      let scale = 1
      for (const p of pts) scale = Math.max(scale, Math.abs(p[0]), Math.abs(p[1]))
      const sideEps = scale * 1e-9
      let minSide = Infinity
      let maxSide = -Infinity
      for (const p of pts) {
        const side = dir2[0] * (p[1] - origin2[1]) - dir2[1] * (p[0] - origin2[0])
        if (side < minSide) minSide = side
        if (side > maxSide) maxSide = side
        if (minSide < -sideEps && maxSide > sideEps) fail()
      }
    } else {
      // The axis meets the plane at exactly one point. That point is the only
      // place a line outside the profile plane can pass through the area.
      const rel = [
        axisOrigin[0] - plane.origin[0],
        axisOrigin[1] - plane.origin[1],
        axisOrigin[2] - plane.origin[2],
      ]
      const t = -dot(rel, plane.normal) / normalComponent
      const hit = [
        axisOrigin[0] + t * axisDirection[0],
        axisOrigin[1] + t * axisDirection[1],
        axisOrigin[2] + t * axisDirection[2],
      ]
      if (pointInLoop(to2d(hit), loop, 16)) fail()
    }
  }
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
  const mergeTarget = (sub.merge_target as string) ?? null

  const sketchRaw = sub.sketch
  const sketchRefs: string[] = Array.isArray(sketchRaw)
    ? (sketchRaw as string[]).filter((s) => s)
    : sketchRaw
      ? [sketchRaw as string]
      : []
  // Nullish, not truthy: an explicit angle=0 must reach the non-zero validation
  // below and fail the feature, not silently become a full turn.
  const angle = Number((sub.angle as number | null | undefined) ?? 360.0)

  if (!Number.isFinite(angle) || angle === 0) throw new Error('revolve: angle must be non-zero')
  if (Math.abs(angle) > 360) throw new Error('revolve: angle must be between -360 and 360')
  if (sketchRefs.length === 0) throw new Error('revolve: requires at least one profile reference')

  const allLoops: Dict[][] = []
  const cqFaces: OccShape[] = []
  let firstPt: PlaneLike | null = null
  let firstSketchId = ''
  const profileErrors: string[] = []
  const profileQueries: string[] = []
  const unbuildableReasons: string[] = []
  // The tool's construction names, keyed by the faces and edges of the tool.
  const names = emptyShapeNames()

  for (const sketchRef of sketchRefs) {
    let resolved
    try {
      resolved = collectExtrudeLoops(oc, scope, table, sketchRef, globalRepo, bodyStore)
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
      } else if (!samePlane(firstPt, resolved.plane)) {
        // Every loop below is lifted through firstPt's frame, so a second sketch
        // on a different plane would build its loops in the wrong place and
        // orientation; refuse it by name instead of building the wrong solid.
        // Face picks stay out of this guard: each face carries its own 3D frame,
        // and the mixed guard below owns them.
        throw new Error(
          `revolve: profile spans two different sketch planes ('${firstSketchId}' and ` +
          `'${resolved.sketchId}'); build one feature per plane`,
        )
      }
    }
    const topo = (globalRepo.elements.get('_topo_' + resolved.sketchId) as Dict | undefined) ?? {}
    // Why an area the user could see and pick will not build. Collected here
    // because this is the one place the sketch's areas are in hand; used only if
    // the profile ends up empty below.
    unbuildableReasons.push(...unbuildableAreaReasons((topo.surfaces as Dict[]) ?? []))
    // The profile handoff also refuses boundaries that never closed or left
    // edges behind; fold those reasons in with the area stamps.
    unbuildableReasons.push(...loopDiagReasons(resolved.loopDiags ?? []))
    for (const surface of (topo.surfaces as Dict[]) ?? []) {
      profileQueries.push(...surfaceEntityIds(surface))
    }
  }

  if (profileErrors.length && cqFaces.length === 0 && allLoops.length === 0) {
    throw new Error(profileErrors.join('; '))
  }

  const bodyId = 'body_' + featureId
  const result: RevolveResult = { status: 'ok', body_id: bodyId }

  if (cqFaces.length === 0 && allLoops.length === 0) {
    // No profile geometry resolved -> no part. A part-less revolve is a failed
    // revolve (surfaced as a red feature), not a silent ok. Reported ahead of
    // the axis guard below: with neither input, the missing profile is the
    // more basic complaint.
    result.status = 'error'
    // Same as extrude: the stamped reason turns "nothing to revolve" into a
    // sentence the user can act on.
    const why = unbuildableReasons.length ? ` (${unbuildableReasons.join('; ')})` : ''
    result.exception = `revolve: no closed profile found in the referenced sketch${why}; no part created`
    result.mesh_warning = 'no closed profile found; body has no shape'
    return result
  }

  if (cqFaces.length > 0 && allLoops.length > 0) {
    // Both were built; only one branch below can consume them, and the silent
    // drop reached applyBodyOperation with profile_queries naming geometry the
    // body does not contain. sweep's mixed-profile guard refuses the same mix by name.
    throw new Error(
      'revolve: a profile mixing picked faces/edges with sketch areas is not supported; ' +
        'use one or the other',
    )
  }

  // Throws when no axis was picked -- never a sweep about a default axis.
  const [axisOrigin, axisDirection] = resolveRevolveAxis(sub, globalRepo, bodyStore)
  const ao = axisOrigin as Vec3
  const ad = axisDirection as Vec3

  // The profile is planar, so the crossing test runs in that plane before any
  // MakeRevol call. Picked faces carry their own frame and are left to OCC.
  if (firstPt !== null && allLoops.length > 0) {
    refuseAxisThroughProfile(allLoops, firstPt, axisOrigin, axisDirection, firstSketchId || 'unknown')
  }

  const operation = ((sub.operation as string) ?? 'add') as BodyOperation
  const direction = (sub.direction as string) ?? 'normal'

  let toolShape: OccShape
  if (allLoops.length === 0) {
    if (direction === 'symmetric') {
      const half = angle / 2.0
      let tool = fuseConsuming(
        oc, scope,
        trackedRevolveFace(oc, scope, cqFaces[0], ao, ad, half),
        revolveFace(oc, scope, cqFaces[0], ao, ad, -half),
      )
      for (const f of cqFaces.slice(1)) {
        const pair = fuseConsuming(
          oc, scope,
          trackedRevolveFace(oc, scope, f, ao, ad, half),
          revolveFace(oc, scope, f, ao, ad, -half),
        )
        tool = fuseConsuming(oc, scope, tool, pair)
      }
      toolShape = tool
    } else {
      const eff = direction === 'reverse' ? -angle : angle
      let tool = trackedRevolveFace(oc, scope, cqFaces[0], ao, ad, eff)
      for (const f of cqFaces.slice(1)) {
        tool = fuseConsuming(oc, scope, tool, revolveFace(oc, scope, f, ao, ad, eff))
      }
      toolShape = tool
    }
  } else {
    if (direction === 'symmetric') {
      // Each half gets a distinct createdBy so their side faces carry different
      // UUIDs, avoiding collisions at the shared seam.
      const half = angle / 2.0
      const pos = revolveProfileWithLineage(oc, scope, allLoops, firstPt as PlaneLike, ao, ad, half, firstSketchId, featureId + '|sym|pos')
      const posTracked = scope.track(pos.solid)
      const neg = revolveProfileWithLineage(oc, scope, allLoops, firstPt as PlaneLike, ao, ad, -half, firstSketchId, featureId + '|sym|neg')
      const negTracked = scope.track(neg.solid)
      // The fuse's face history carries each half's names onto the tool; the
      // edges are derived again on the fused tool.
      const fused = booleanWithHistory(oc, scope, posTracked, negTracked, 'fuse')
      toolShape = scope.track(fused.shape)
      scope.release(posTracked)
      scope.release(negTracked)
      mergeShapeNames(mergeShapeNames(names, pos), neg)
      names.faceNames = carryFaceNames(fused.faceOrigin, pos.faceNames, neg.faceNames)
      const edges = deriveEdgeNames(oc, scope, toolShape, names.faceNames, names.faceAncestry)
      names.edgeNames = edges.edgeNames
      Object.assign(names.edgeAncestry, edges.edgeAncestry)
    } else {
      const eff = direction === 'reverse' ? -angle : angle
      const lineage = revolveProfileWithLineage(oc, scope, allLoops, firstPt as PlaneLike, ao, ad, eff, firstSketchId, featureId)
      toolShape = scope.track(lineage.solid)
      mergeShapeNames(names, lineage)
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
    faceNames: names.faceNames,
    edgeNames: names.edgeNames,
    faceAncestry: names.faceAncestry,
    edgeAncestry: names.edgeAncestry,
    capAncestry: names.capAncestry,
  })
  Object.assign(result, opResult)

  if (profileErrors.length) {
    result.status = 'partial'
    result.exception = profileErrors.join('; ')
  }

  return result
}
