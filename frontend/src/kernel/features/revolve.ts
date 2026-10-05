// The revolve leaf, analogous to extrude but sweeping each profile around an axis. It resolves
// each profile to 2D loops (or a body face), resolves the revolve axis (an `axis` query and/or a
// stored origin/direction, the query flipped to agree with the stored direction), builds the tool
// solid with per-entity lineage, and applies the body operation. An axis-less revolve is a solve
// error, never a revolve about world Z -- see resolveRevolveAxis.
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
import { samePlane, sketchToWorld2d, surfaceEntityIds, unbuildableAreaReasons, loopDiagReasons, type PlaneLike } from './shared'
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
 * Read one stored axis vector, or null when the field is absent. A present but
 * malformed vector (wrong arity, NaN, a string) is a throw, not a silent
 * fallback: it would otherwise reach OCC as a garbage `Vec3`.
 */
function readAxisVector(raw: unknown, field: string): number[] | null {
  if (raw === undefined || raw === null) return null
  const vec = Array.isArray(raw) ? raw.map(Number) : []
  if (vec.length !== 3 || vec.some((c) => !Number.isFinite(c))) {
    throw new Error(`revolve: ${field} must be three finite numbers, got ${JSON.stringify(raw)}`)
  }
  return vec
}

/**
 * Resolve the revolve axis (mirrors the inline block in `_solve_revolve`). Starts
 * from the stored origin/direction; an `axis` query overrides them but is flipped
 * (origin becomes the line's far end, direction negated) when it points opposite
 * the stored direction.
 *
 * The axis is REQUIRED. With neither an `axis` query nor a stored
 * `axis_direction` the resolver throws rather than revolving about world Z at
 * the world origin: a revolve has no meaningful default axis, and the arbitrary
 * one silently produced a plausible-looking wrong solid. Same contract as the
 * circular-array leaf (`circular_array: axis is required`) and the array
 * direction picks. A stored `axis_direction` without an `axis_origin` is
 * accepted as that direction through the world origin -- the direction was
 * stated deliberately, only the anchor is conventional.
 *
 * Fail-loud guards: when an `axis` query is set but the registry returns null
 * (stale pick -- the body rebuild minted new ancestry tokens, the edge was
 * deleted, or the sketch line was removed), OR when the resolved payload carries
 * no usable axis geometry (a degenerate line, a missing sketch plane, or an
 * unrecognised shape), the resolver throws instead of silently falling back to
 * the stored/default axis. A silent fallback there produces a wrong (squished)
 * solid the user can't diagnose; a thrown error surfaces the revolve as a red
 * feature so the user re-picks the axis. Mirrors the rotation-axis guard in
 * transformMirror (`transform: rotation_axis not found`).
 */
export function resolveRevolveAxis(
  feature: Dict,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
): [number[], number[]] {
  const axisQuery = (feature.axis as string | undefined) || undefined
  const storedOrigin = readAxisVector(feature.axis_origin, 'axis_origin')
  const storedDir = readAxisVector(feature.axis_direction, 'axis_direction')
  if (storedDir && Math.hypot(storedDir[0], storedDir[1], storedDir[2]) <= 1e-12) {
    throw new Error(`revolve: axis_direction must be a non-zero vector, got ${JSON.stringify(feature.axis_direction)}`)
  }
  if (!axisQuery && !storedDir) {
    throw new Error(
      'revolve: axis is required; pick an edge, sketch entity, or face ' +
        '(or store axis_origin + axis_direction)',
    )
  }

  let axisOrigin = storedOrigin ?? [0, 0, 0]
  // Only reachable with an `axis` query in hand (the guard above rejects the
  // axis-less case), where it is the sign reference the query is flipped to
  // agree with -- never the axis the revolve is built about.
  let axisDirection = storedDir ?? [0, 0, 1]
  const storedDirection = [...axisDirection]
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
  // Nullish, not truthy: an explicit angle=0 must reach the non-zero validation
  // below and fail the feature, not silently become a full turn.
  const angle = Number((merged.angle as number | null | undefined) ?? 360.0)

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
  const faceNames: Record<string, string> = {}
  const edgeNames: Record<string, string> = {}
  const faceAncestry: Lineage = {}
  const edgeAncestry: Lineage = {}

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

  // Throws when no axis was picked or stored -- never a sweep about world Z.
  const [axisOrigin, axisDirection] = resolveRevolveAxis(merged, globalRepo, bodyStore)
  const ao = axisOrigin as Vec3
  const ad = axisDirection as Vec3

  const operation = ((merged.operation as string) ?? 'add') as BodyOperation
  const direction = (merged.direction as string) ?? 'normal'

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
      toolShape = scope.track(fuse(oc, scope, posTracked, negTracked))
      scope.release(posTracked)
      scope.release(negTracked)
      Object.assign(faceNames, pos.faceNames, neg.faceNames)
      Object.assign(edgeNames, pos.edgeNames, neg.edgeNames)
      Object.assign(faceAncestry, pos.faceAncestry, neg.faceAncestry)
      Object.assign(edgeAncestry, pos.edgeAncestry, neg.edgeAncestry)
    } else {
      const eff = direction === 'reverse' ? -angle : angle
      const lineage = revolveProfileWithLineage(oc, scope, allLoops, firstPt as PlaneLike, ao, ad, eff, firstSketchId, featureId)
      toolShape = scope.track(lineage.solid)
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
