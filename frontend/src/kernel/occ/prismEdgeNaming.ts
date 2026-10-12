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
import type { OccModule, OccShape, OccSubShape } from './occTypes'
import { edgeToGeom } from './primitives'
import type { LoopEdge } from '../profileLoops'
import type { PlaneLike } from '../features/shared/planes'
import { POINT_TOL, pointsMatch, uvTo3d } from './prismGeometry'
import { nameEdgeGroups, type FaceEdgeTable } from './constructionLineage'
import { SubShapeMap } from './subshapeIdentity'
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
 * `table` is the solid's face/edge topology.
 *
 * A pair sharing >1 edge (multiplicity) is ordered by `orderSplitChildren` and
 * refuses on a near-tie, and an edge that is neither between two named faces nor
 * a single-face seam is a non-manifold junction or an unrescued topology, which
 * fails loud rather than silently collapsing onto the body-wide query. With
 * `strict` off (a fused multi-group solid, where a merged face may legitimately
 * stay unnamed) such an edge is just left unnamed.
 */
export function derivePrismEdgeNames(
  oc: OccModule,
  scope: DisposeScope,
  table: FaceEdgeTable,
  faceNames: SubShapeMap<string>,
  faceAncestry: Record<string, string[]>,
  createdBy: string,
  strict = true,
): { edgeNames: SubShapeMap<string>; edgeAncestry: Record<string, string[]> } {
  // solid edge -> the uuids of its named adjacent faces, every edge once in
  // first-seen order.
  const adjacency = new SubShapeMap<Set<string>>()
  const edgeOrder: OccSubShape[] = []
  for (const row of table.rows) {
    const uuid = faceNames.get(row.face)
    for (const edge of row.edges) {
      let set = adjacency.get(edge)
      if (set === undefined) {
        adjacency.set(edge, (set = new Set()))
        edgeOrder.push(edge)
      }
      if (uuid) set.add(uuid)
    }
  }

  // Group edges by their face-pair so a pair sharing >1 edge (multiplicity) is
  // ordered deterministically and each edge gets a stable multiplicity index.
  const byPair = new Map<string, OccSubShape[]>()  // "uuidA|uuidB" -> its edges
  const bySingle = new Map<string, OccSubShape[]>()  // "uuidA" -> its seam edges
  const group = (groups: Map<string, OccSubShape[]>, key: string, edge: OccSubShape): void => {
    const list = groups.get(key)
    if (list === undefined) groups.set(key, [edge])
    else list.push(edge)
  }
  for (const edge of edgeOrder) {
    const distinct = [...adjacency.get(edge)!]
    // Two named faces -> normal edge; one named face -> seam edge (e.g. a
    // circle-extrude cylinder's lateral seam). Both get a UUID so no pickable
    // edge falls back to the ambiguous createdBy+classifiers query.
    if (distinct.length === 2) {
      group(byPair, [...distinct].sort().join('|'), edge)
    } else if (distinct.length === 1) {
      group(bySingle, distinct[0], edge)
    } else if (strict) {
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
  // An edge's tokens are the union of its named adjacent faces' ancestry.
  return nameEdgeGroups(oc, scope, table, faceNames, byPair, bySingle, (_uuids, edge) => {
    const tokens: string[] = []
    for (const fu of adjacency.get(edge) ?? []) {
      for (const t of faceAncestry[fu] ?? []) if (!tokens.includes(t)) tokens.push(t)
    }
    return tokens
  })
}
