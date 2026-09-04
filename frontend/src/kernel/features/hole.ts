// The hole leaf. For each drill site the `sketch` ref names it drills a cylinder (blind depth
// or through-all) and boolean-cuts it from the target body. Composite of the cut boolean
// + cylinder primitive.
//
// The ref is a pick chip's raw value, so it names either a whole sketch (every point entity in
// it, the original behaviour) or ONE picked entity -- a point, or a circle that carries its own
// diameter. parseHoleSketchRef / drilledEntities / drillSite below are that rule; a pick that
// names no drill site is refused there by name.
//
// through_all sizes the cylinder from the target's edge-sampled AABB (bodyFrame).
// The stock OCC build has no Bnd_Box, and a vertex-only box is NOT a safe
// stand-in for one: an OCCT cylinder carries just two seam vertices, so its
// vertex box collapses radially and a radial through-hole sized from it
// under-penetrates by roughly the full diameter, leaving the far wall intact.
// Sampling the edges (the cap circles) recovers the true extent, matching
// Python's Bnd_Box-sized cylinder.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body, BrepDiff } from '../types3d'
import type { Repository } from '../query'
import { parseSketchEntityRef, resolveBody, sketchIdFromQuery, soleEntityInQuery, mergeBrepDiff } from './shared'
import { makeCylinder, type Vec3 } from '../occ/primitives'
import { bodyFrame } from '../occ/tessellation'
import { booleanWithDiff } from '../occ/booleans'
import { resplitBody } from './bodySplit'
import type { PlaneLike } from './shared'

type Dict = Record<string, unknown>

interface HoleResult {
  [key: string]: unknown
  status: string
  body_id: string
  body_ids: string[]
  hole_count: number
}

/**
 * The sketch a hole's `sketch` ref names, and the ONE entity of it the pick
 * narrows to (null = the whole sketch).
 *
 * A hole's sketch field is a pick chip like any other, so it holds whatever the
 * viewport toggled: a feature-tree click on the sketch gives `@<sketchId>`, but
 * a click in the 3D view gives `entity:<sk>:<eid>` / `vertex:<sk>:<eid>:<sub>`
 * for a curve or a vertex, and a `?...` ancestry query for an area fill. Those
 * three used to reach `_pt_entity:<sk>:<eid>` verbatim and red the feature out
 * with "has no plane transform registered", which named nothing the user could
 * act on -- picking in the viewport, the obvious gesture, was the one that could
 * not work. This is the single decoder for all four forms; `entity:`/`vertex:`
 * and a single-entity area pick narrow the drill to that entity, everything else
 * keeps the whole-sketch meaning `@<sketchId>` always had.
 */
function parseHoleSketchRef(
  ref: string,
  globalRepo: Repository,
): { sketchId: string; entityId: string | null } {
  const picked = parseSketchEntityRef(ref)
  if (picked !== null) return { sketchId: picked.sketchId, entityId: picked.eid }
  if (ref.startsWith('?')) {
    const sketchId = sketchIdFromQuery(ref, globalRepo)
    // A query naming no sketch (a body face, say) keeps the raw ref, so the
    // plane lookup below refuses the pick by name rather than silently drilling
    // some other sketch.
    if (sketchId === null) return { sketchId: ref, entityId: null }
    return { sketchId, entityId: soleEntityInQuery(ref, sketchId) }
  }
  return { sketchId: ref.replace(/^[@$]+/, ''), entityId: null }
}

/**
 * Where one entity puts a drill and how wide, or null when the solver left it
 * without geometry (the caller counts those as skipped).
 *
 * A point entity is the classic hole site: it names a position and nothing else,
 * so the feature's own diameter applies. A picked CIRCLE names both -- position
 * and size -- and its size wins, because the hole it asks for is the hole the
 * user drew and can see; the same pick through an extrude cut removes exactly
 * that cylinder, and a hole that came out at the field's diameter instead would
 * disagree with the circle still sitting in the sketch. Nothing else is a drill
 * site: a line, an arc or a spline names no enclosed circle, so those are
 * refused rather than reduced to some point on them.
 */
function drillSite(
  globalRepo: Repository,
  sketchId: string,
  entity: Dict,
  featureRadius: number,
): { xy: number[]; radius: number } | null {
  const eid = entity.id as string
  if (entity.kind === 'circle') {
    const solved = globalRepo.elements.get(sketchId + '/' + eid) as Dict | undefined
    const params = solved?.external_params as number[] | undefined
    if (params === undefined || params.length < 3 || !(params[2] > 0)) return null
    return { xy: [params[0], params[1]], radius: params[2] }
  }
  const xyEntry = globalRepo.elements.get(sketchId + '/' + eid + '/xy') as Dict | undefined
  if (xyEntry === undefined) return null
  return { xy: xyEntry.external_xy as number[], radius: featureRadius }
}

/**
 * The entities this hole drills. A pick that named one entity drills that one
 * and nothing else -- a user who clicked a single point does not expect the
 * other points in the sketch to be drilled too -- and a pick that named the
 * sketch drills every point in it, as it always has.
 */
function drilledEntities(
  entities: Dict[],
  sketchId: string,
  entityId: string | null,
): Dict[] {
  if (entityId === null) {
    const points = entities.filter((e) => e.kind === 'point')
    if (points.length === 0) throw new Error(`hole: sketch '${sketchId}' has no point entities`)
    return points
  }
  const picked = entities.find((e) => e.id === entityId)
  if (picked === undefined) throw new Error(`hole: sketch '${sketchId}' has no entity '${entityId}'`)
  if (picked.kind !== 'point' && picked.kind !== 'circle') {
    throw new Error(
      `hole: '${entityId}' of sketch ${sketchId} is a ${picked.kind}, which names no drill site; ` +
      'pick a sketch point or a circle, or the sketch itself',
    )
  }
  return [picked]
}

/** Max-axis extent of the target's edge-sampled AABB: the length a through-all
 *  cutter must clear. Vertices alone understate curved bodies (a cylinder's
 *  only vertices sit on its seam), so the edge samples carry the silhouette. */
function bodySpan(oc: OccModule, scope: DisposeScope, shape: OccShape): number {
  const { half } = bodyFrame(oc, scope, shape)
  return 2.0 * Math.max(half[0], half[1], half[2])
}

/** Solve a hole feature into the body store (mirrors `_solve_hole`). */
export function solveHole(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
  featuresById: Record<string, Dict>,
): HoleResult {
  const sub = (feature.hole as Dict) ?? {}
  const { sketchId, entityId } = parseHoleSketchRef((sub.sketch as string) ?? '', globalRepo)
  const diameter = Number(sub.diameter ?? 10.0)
  const depthMode = (sub.depth_mode as string) ?? 'blind'
  const depth = Number(sub.depth ?? 10.0)
  const direction = (sub.direction as string) ?? 'normal'
  const targetRef = (sub.target as string) ?? ''

  if (!Number.isFinite(diameter) || diameter <= 0) throw new Error('hole: diameter must be positive')
  if (depthMode !== 'through_all') {
    if (!Number.isFinite(depth) || depth <= 0) throw new Error('hole: depth must be positive')
  }

  const radius = diameter / 2.0

  const plane = globalRepo.elements.get('_pt_' + sketchId) as PlaneLike | undefined
  if (plane === undefined) {
    throw new Error(`hole: sketch '${sketchId}' has no plane transform registered`)
  }
  const origin = plane.origin
  const xAxis = plane.x_axis
  const yAxis = plane.y_axis
  const normal = plane.normal
  const axis: Vec3 = (direction === 'normal' ? normal : normal.map((n) => -n)) as Vec3

  let targetBody: Body
  if (targetRef) {
    targetBody = resolveBody(targetRef, bodyStore)
  } else {
    const ids = Object.keys(bodyStore)
    if (ids.length === 0) throw new Error('hole: no bodies in body_store and no target specified')
    targetBody = bodyStore[ids[0]]
  }
  if (targetBody.shape === null) throw new Error(`hole: target body '${targetBody.id}' has no shape`)

  const sketchFeature = featuresById[sketchId] ?? {}
  const drilled = drilledEntities((sketchFeature.entities as Dict[]) ?? [], sketchId, entityId)

  let currentShape = table.get<OccShape>(targetBody.shape)

  let throughDepth = 0.0
  let throughBackOffset = 0.0
  if (depthMode === 'through_all') {
    const span = bodySpan(oc, scope, currentShape)
    throughDepth = span * 3.0
    throughBackOffset = span
  }

  let skippedCount = 0
  const skippedEntityIds: string[] = []
  let accumulatedDiff: BrepDiff | null = targetBody.brep_diff
  let cutAny = false

  for (let i = 0; i < drilled.length; i++) {
    const entity = drilled[i]
    const eid = entity.id as string
    const site = drillSite(globalRepo, sketchId, entity, radius)
    if (site === null) {
      skippedCount++
      skippedEntityIds.push(eid)
      continue
    }
    const [x2d, y2d] = site.xy
    const center3d: Vec3 = [
      origin[0] + x2d * xAxis[0] + y2d * yAxis[0],
      origin[1] + x2d * xAxis[1] + y2d * yAxis[1],
      origin[2] + x2d * xAxis[2] + y2d * yAxis[2],
    ]

    let start3d: Vec3
    let h: number
    if (depthMode === 'through_all') {
      start3d = [
        center3d[0] - axis[0] * throughBackOffset,
        center3d[1] - axis[1] * throughBackOffset,
        center3d[2] - axis[2] * throughBackOffset,
      ]
      h = throughDepth
    } else {
      start3d = center3d
      h = depth
    }

    const cyl = scope.track(makeCylinder(oc, scope, start3d, axis, site.radius, h))
    const res = booleanWithDiff(oc, scope, currentShape, cyl, 'cut', { unifyFaces: !targetBody.imported })
    scope.release(cyl)
    if (i > 0) scope.release(currentShape)
    currentShape = scope.track(res.shape)
    // Accumulate per-cut diffs so all rims survive, not just the last.
    accumulatedDiff = mergeBrepDiff(accumulatedDiff, res.diff)
    cutAny = true
  }

  const total = drilled.length
  const placed = total - skippedCount
  if (placed === 0) {
    // Fail before any bookkeeping. This branch deliberately skips the brep_diff
    // update, so pushing modified_by first would make ancestry re-read the
    // stale diff and pin the PREVIOUS op's sub-shapes on this failed feature.
    throw new Error(
      `hole: all ${total} drill site(s) in sketch '${sketchId}' have no solved geometry; nothing to place`,
    )
  }

  let bodyIds = [targetBody.id]
  if (cutAny) {
    // A hole is a cut, so it can sever the body: a through-hole wider than the
    // web between two features leaves two disconnected solids.
    bodyIds = resplitBody(oc, scope, table, bodyStore, targetBody, currentShape, feature.id as string)
    targetBody.brep_diff = accumulatedDiff
    targetBody.modified_by.push(feature.id as string)
  }

  const result: HoleResult = {
    status: skippedCount > 0 ? 'partial' : 'ok',
    body_id: bodyIds[0],
    body_ids: bodyIds,
    hole_count: placed,
  }
  if (skippedCount > 0) {
    // Wording pinned by the frozen parity snapshot (occ/__fixtures__/hole.json,
    // case `partial_skip`): reword it and the golden result stops matching.
    result.exception = `hole: ${skippedCount}/${total} point(s) skipped, no XY data for: ${skippedEntityIds.join(', ')}`
  }
  return result
}
