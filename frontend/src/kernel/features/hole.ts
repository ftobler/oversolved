// The hole leaf. For each point entity in the referenced sketch it drills a cylinder (blind
// depth or through-all) and boolean-cuts it from the target body. Composite of the cut boolean
// + cylinder primitive.
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
import { resolveBody } from './shared'
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
  const sketchRef = ((sub.sketch as string) ?? '').replace(/^@+/, '')
  const diameter = Number(sub.diameter ?? 10.0)
  const depthMode = (sub.depth_mode as string) ?? 'blind'
  const depth = Number(sub.depth ?? 10.0)
  const direction = (sub.direction as string) ?? 'normal'
  const targetRef = (sub.target as string) ?? ''

  const radius = diameter / 2.0

  const plane = globalRepo.elements.get('_pt_' + sketchRef) as PlaneLike | undefined
  if (plane === undefined) {
    throw new Error(`hole: sketch '${sketchRef}' has no plane transform registered`)
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

  const sketchFeature = featuresById[sketchRef] ?? {}
  const entities = (sketchFeature.entities as Dict[]) ?? []
  const pointEntities = entities.filter((e) => e.kind === 'point')
  if (pointEntities.length === 0) throw new Error(`hole: sketch '${sketchRef}' has no point entities`)

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
  let lastDiff: BrepDiff | null = targetBody.brep_diff
  let cutAny = false

  for (const entity of pointEntities) {
    const eid = entity.id as string
    const xyEntry = globalRepo.elements.get(sketchRef + '/' + eid + '/xy') as Dict | undefined
    if (xyEntry === undefined) {
      skippedCount++
      skippedEntityIds.push(eid)
      continue
    }
    const [x2d, y2d] = xyEntry.external_xy as number[]
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

    const cyl = makeCylinder(oc, scope, start3d, axis, radius, h)
    const res = booleanWithDiff(oc, scope, currentShape, cyl, 'cut')
    currentShape = scope.track(res.shape)
    lastDiff = res.diff
    cutAny = true
  }

  let bodyIds = [targetBody.id]
  if (cutAny) {
    // A hole is a cut, so it can sever the body: a through-hole wider than the
    // web between two features leaves two disconnected solids.
    bodyIds = resplitBody(oc, scope, table, bodyStore, targetBody, currentShape, feature.id as string)
    targetBody.brep_diff = lastDiff
  }

  targetBody.modified_by.push(feature.id as string)
  const total = pointEntities.length
  const placed = total - skippedCount
  if (placed === 0) {
    throw new Error(
      `hole: all ${total} point(s) in sketch '${sketchRef}' have no XY data; nothing to place`,
    )
  }

  const result: HoleResult = {
    status: skippedCount > 0 ? 'partial' : 'ok',
    body_id: bodyIds[0],
    body_ids: bodyIds,
    hole_count: placed,
  }
  if (skippedCount > 0) {
    result.exception = `hole: ${skippedCount}/${total} point(s) skipped, no XY data for: ${skippedEntityIds.join(', ')}`
  }
  return result
}
