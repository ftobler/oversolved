// The two edge passes of the prism/sweep lineage: map each profile-face OCC
// edge to a sketch entity id by geometry, then derive a construction UUID per
// solid edge from its two adjacent face UUIDs. Split out of prismLineage.ts so
// the brep producer keeps only the face/cap naming and the orchestration.
//
// Both passes are deliberately separate from constructionLineage.deriveEdgeNames:
// they must account for edges whose adjacent faces are UNNAMED (a non-manifold
// junction or an unrescued topology) and fail loud on them, whereas the generic
// derivation simply skips an edge no named face touches.

import type { DisposeScope } from './disposeScope'
import type { OccModule, OccShape } from './occTypes'
import { edgeToGeom } from './primitives'
import type { LoopEdge } from '../profileLoops'
import type { PlaneLike } from '../features/shared/planes'
import { POINT_TOL, pointsMatch, uvTo3d } from './prismGeometry'
import {
  edgeMidpoint,
  normalizedWorldKey,
  shapeNormalFrame,
  type NormalFrame,
} from './constructionLineage'
import {
  deriveEdgeUuid,
  deriveSeamEdgeUuid,
  orderSplitChildren,
  type SplitChild,
} from '../constructionName'
import { failLoud } from '@/utils/invariants'
import { isDevBuild } from '../isDevBuild'

/** An OCC edge's endpoints plus (for circles) the center/radius read off it. */
interface OccEdgeEndpoints {
  sp: number[]
  ep: number[]
  kind: string
  center?: number[]
  radius?: number
}

/**
 * Pre-read each OCC edge's endpoints and, for circles, its center/radius. The
 * gp_Pnt proxies are by-value returns; only their coordinates survive, so they
 * are deleted before anything can throw.
 */
function readOccEdgeEndpoints(
  oc: OccModule,
  scope: DisposeScope,
  occEdges: OccShape[],
): OccEdgeEndpoints[] {
  return occEdges.map((e) => {
    const ad = scope.track(new oc.BRepAdaptor_Curve_2(e))
    const sp = ad.Value(ad.FirstParameter())
    const ep = ad.Value(ad.LastParameter())
    const start: number[] = [sp.X(), sp.Y(), sp.Z()]
    const end: number[] = [ep.X(), ep.Y(), ep.Z()]
    sp.delete()
    ep.delete()
    const { ed } = edgeToGeom(oc, scope, e)
    return {
      sp: start,
      ep: end,
      kind: ed.kind,
      center: (ed as { center?: number[] }).center,
      radius: (ed as { radius?: number }).radius,
    }
  })
}

/** Does a closed OCC circle edge match this sketch circle/arc entity? */
function closedCircleMatchesEntity(
  entity: LoopEdge,
  ep: OccEdgeEndpoints,
  plane: PlaneLike,
): boolean {
  const kind = entity['kind'] as string | undefined
  const ecenter = entity['center'] as number[] | undefined
  if ((kind !== 'circle' && kind !== 'arc') || ecenter === undefined) return false
  if (ep.kind !== 'circle') return false
  if (!pointsMatch(ep.sp, ep.ep)) return false  // not a closed circle
  if (ep.center === undefined || ep.radius === undefined) return false
  const center3d = uvTo3d(plane, ecenter)
  return (
    pointsMatch(center3d, ep.center) &&
    Math.abs(((entity['radius'] as number) ?? 0.0) - ep.radius) < POINT_TOL
  )
}

/**
 * Map each profile-face OCC edge (explorer order) to a sketch entity id, by
 * matching 3D endpoints (mirrors `_entity_to_occ_edge_map`). Each OCC edge maps
 * to at most one entity, and entities claim the first matching unclaimed edge,
 * iterating entities in loop order (so the assignment matches Python).
 */
export function entityForEdges(
  oc: OccModule,
  scope: DisposeScope,
  occEdges: OccShape[],
  loops: LoopEdge[][],
  plane: PlaneLike,
): (string | null)[] {
  const result: (string | null)[] = new Array(occEdges.length).fill(null)
  const endpoints = readOccEdgeEndpoints(oc, scope, occEdges)

  for (const loop of loops) {
    for (const entity of loop) {
      const eid = (entity['id'] as string | undefined) ?? ''
      if (!eid) continue
      const start3d = uvTo3d(plane, (entity['start'] as number[] | undefined) ?? [0.0, 0.0])
      const end3d = uvTo3d(plane, (entity['end'] as number[] | undefined) ?? [0.0, 0.0])
      for (let i = 0; i < occEdges.length; i++) {
        if (result[i] !== null) continue
        const ep = endpoints[i]
        if (
          (pointsMatch(start3d, ep.sp) && pointsMatch(end3d, ep.ep)) ||
          (pointsMatch(start3d, ep.ep) && pointsMatch(end3d, ep.sp)) ||
          closedCircleMatchesEntity(entity, ep, plane)
        ) {
          result[i] = eid
          break
        }
      }
    }
  }
  return result
}

/**
 * Derive each solid edge's construction UUID from its two adjacent face UUIDs.
 * `adjacency` maps an edge geom hash to every adjacent face geom hash (named or
 * not); `edgeShapes` maps it to a representative edge for the split ordering.
 *
 * A pair sharing >1 edge (multiplicity) is ordered by `orderSplitChildren` and
 * refuses on a near-tie, and an edge that is neither between two named faces nor
 * a single-face seam is a non-manifold junction or an unrescued topology, which
 * fails loud rather than silently collapsing onto the body-wide query.
 */
export function derivePrismEdgeNames(
  oc: OccModule,
  scope: DisposeScope,
  solid: OccShape,
  adjacency: Record<string, Set<string>>,
  faceNames: Record<string, string>,
  faceAncestry: Record<string, string[]>,
  edgeShapes: Record<string, OccShape>,
  createdBy: string,
): { edgeNames: Record<string, string>; edgeAncestry: Record<string, string[]> } {
  // solid edge -> tokens, gathered from adjacent faces' ancestry.
  const edgeLineage: Record<string, string[]> = {}
  for (const [egh, faceGhs] of Object.entries(adjacency)) {
    const tokens: string[] = []
    for (const fgh of faceGhs) {
      const fu = faceNames[fgh]
      if (!fu) continue
      for (const t of faceAncestry[fu] ?? []) {
        if (!tokens.includes(t)) tokens.push(t)
      }
    }
    edgeLineage[egh] = tokens
  }

  // solid edge -> construction uuid, derived from its two adjacent face uuids.
  // Group edges by their face-pair so a pair sharing >1 edge (multiplicity) is
  // ordered deterministically and each edge gets a stable multiplicity index.
  const edgeNames: Record<string, string> = {}
  const edgeAncestry: Record<string, string[]> = {}
  const byPair: Record<string, string[]> = {}  // "uuidA|uuidB" -> [edge gh...]
  const bySingle: Record<string, string[]> = {}  // "uuidA" -> [seam edge gh...]
  for (const [egh, faceGhs] of Object.entries(adjacency)) {
    const uuids = [...faceGhs].map((fgh) => faceNames[fgh]).filter((u): u is string => Boolean(u))
    const distinct = [...new Set(uuids)]
    // Two named faces -> normal edge; one named face -> seam edge (e.g. a
    // circle-extrude cylinder's lateral seam). Both get a UUID so no pickable
    // edge falls back to the ambiguous createdBy+classifiers query.
    if (distinct.length === 2) {
      (byPair[[...distinct].sort().join('|')] ??= []).push(egh)
    } else if (distinct.length === 1) {
      (bySingle[distinct[0]] ??= []).push(egh)
    } else {
      // Neither an edge between two named faces nor a single-face seam: a
      // non-manifold junction (>2) or an edge every adjacent face stayed
      // unnamed on (0) after the neighbour pass. Both would collapse onto the
      // identical body-wide ancestral query, so flag them instead of silently
      // leaving the edge unnameable.
      const message =
        `[prismLineage] edge has ${distinct.length} distinct named adjacent faces ` +
        `(expected 1 or 2): non-manifold or unrescued topology (${createdBy})`
      // failLoud throws in tests and warns in dev only, so pair it with a
      // production-visible warning: this is a real topology condition, not a
      // harness invariant, and in production it would otherwise pass in
      // silence.
      if (!isDevBuild()) console.warn(message)
      failLoud(message)
    }
  }
  // Edge midpoints are world coordinates: normalize them by the parent
  // solid's span so a uniform resize cancels and the refusal is relative.
  let frame: NormalFrame | null = null
  for (const [pairKey, eghs] of Object.entries(byPair)) {
    const [a, b] = pairKey.split('|')
    let ordered: string[] | null = eghs
    if (eghs.length > 1) {
      frame ??= shapeNormalFrame(oc, scope, solid)
      const f = frame
      const children: SplitChild<string>[] = eghs.map((egh) => ({
        item: egh,
        key: normalizedWorldKey(f, edgeMidpoint(oc, scope, edgeShapes[egh])),
      }))
      ordered = orderSplitChildren(children)  // null on a near-tie -> leave unnamed
    }
    if (ordered === null) continue
    ordered.forEach((egh, i) => {
      const uuid = deriveEdgeUuid(a, b, eghs.length > 1 ? i : 0)
      edgeNames[egh] = uuid
      edgeAncestry[uuid] = [...(edgeLineage[egh] ?? [])]
    })
  }
  for (const [faceUuid, eghs] of Object.entries(bySingle)) {
    let ordered: string[] | null = eghs
    if (eghs.length > 1) {
      frame ??= shapeNormalFrame(oc, scope, solid)
      const f = frame
      const children: SplitChild<string>[] = eghs.map((egh) => ({
        item: egh,
        key: normalizedWorldKey(f, edgeMidpoint(oc, scope, edgeShapes[egh])),
      }))
      ordered = orderSplitChildren(children)  // null on a near-tie -> leave unnamed
    }
    if (ordered === null) continue
    ordered.forEach((egh, i) => {
      const uuid = deriveSeamEdgeUuid(faceUuid, eghs.length > 1 ? i : 0)
      edgeNames[egh] = uuid
      edgeAncestry[uuid] = [...(edgeLineage[egh] ?? [])]
    })
  }
  return { edgeNames, edgeAncestry }
}
