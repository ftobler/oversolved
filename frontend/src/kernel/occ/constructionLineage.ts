// Edge construction names derived from face adjacency (query-naming-by-
// construction.md). An edge is the intersection of two faces, so its UUID is
// derived from the two adjacent face UUIDs -- op-independent, computed uniformly
// after any producer has minted the face names. Multiplicity (a face pair
// sharing >1 edge) is ordered by `orderSplitChildren` and refuses on a near-tie.

import { type DisposeScope } from './disposeScope'
import type { OccModule, OccShape } from './occTypes'
import { edgeToGeom, faceCentroid, faceNormal, faceArea } from './primitives'
import { faceGh, edgeGh } from './lineageHash'
import { normalToFrame, projectWorldToFrame } from '../types3d'
import { deriveEdgeUuid, orderSplitChildren, type SplitChild } from '../constructionName'

/**
 * A child face centroid expressed in its split parent's normalized in-plane
 * frame: the relative, resize-invariant ordering key for split siblings. The
 * frame comes from the parent's own centroid + normal, scaled by the parent's
 * characteristic length (sqrt area), so a uniform resize of the parent cancels.
 */
export function faceSplitKey(oc: OccModule, scope: DisposeScope, parent: OccShape, child: OccShape): number[] {
  const pc = faceCentroid(oc, scope, parent)
  const pn = faceNormal(oc, scope, parent) as [number, number, number]
  const pa = faceArea(oc, scope, parent)
  const { x_axis, y_axis } = normalToFrame(pn)
  const cc = faceCentroid(oc, scope, child)
  const frame = { origin: pc as [number, number, number], x_axis, y_axis, normal: pn }
  const [u, v] = projectWorldToFrame(cc as [number, number, number], frame)
  const s = Math.sqrt(Math.max(pa, 1e-9))
  return [u / s, v / s]
}

/** A relative ordering key for an edge (its midpoint), for split multiplicity. */
function edgeOrderKey(oc: OccModule, scope: DisposeScope, edge: OccShape): number[] {
  try {
    const { ed } = edgeToGeom(oc, scope, edge)
    const s = (ed as { start?: number[] }).start
    const e = (ed as { end?: number[] }).end
    const c = (ed as { center?: number[] }).center
    if (Array.isArray(s) && Array.isArray(e)) {
      return [(s[0] + e[0]) / 2, (s[1] + e[1]) / 2, (s[2] + e[2]) / 2]
    }
    if (Array.isArray(c)) return [...c]
  } catch {
    // fall through
  }
  return [0, 0, 0]
}

/**
 * (edge_names, edge_ancestry) for a shape, derived from a face-name map
 * (faceGh -> uuid) and face-ancestry map (uuid -> tokens). Each edge whose two
 * adjacent faces are both named gets a UUID from that face pair; the ancestry is
 * the union of the two faces' ancestry tokens.
 */
export function deriveEdgeNames(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  faceNames: Record<string, string>,
  faceAncestry: Record<string, string[]>,
): { edgeNames: Record<string, string>; edgeAncestry: Record<string, string[]> } {
  const E = oc.TopAbs_ShapeEnum
  const adjacency: Record<string, Set<string>> = {}  // edge gh -> set of adjacent face uuid
  const edgeShapes: Record<string, OccShape> = {}  // edge gh -> a representative edge
  const faceExp = scope.track(new oc.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  for (; faceExp.More(); faceExp.Next()) {
    const face = scope.track(oc.TopoDS.Face_1(faceExp.Current()))
    const uuid = faceNames[faceGh(oc, scope, face)]
    if (!uuid) continue
    const eExp = scope.track(new oc.TopExp_Explorer_2(face, E.TopAbs_EDGE, E.TopAbs_SHAPE))
    for (; eExp.More(); eExp.Next()) {
      const edge = scope.track(oc.TopoDS.Edge_1(eExp.Current()))
      const egh = edgeGh(oc, scope, edge)
      if (egh === null) continue
      ;(adjacency[egh] ??= new Set()).add(uuid)
      edgeShapes[egh] ??= edge
    }
  }

  const edgeNames: Record<string, string> = {}
  const edgeAncestry: Record<string, string[]> = {}
  const byPair: Record<string, string[]> = {}  // "uuidA|uuidB" -> [edge gh...]
  for (const [egh, uuidSet] of Object.entries(adjacency)) {
    const distinct = [...uuidSet]
    if (distinct.length !== 2) continue
    const pairKey = [...distinct].sort().join('|')
    ;(byPair[pairKey] ??= []).push(egh)
  }
  for (const [pairKey, eghs] of Object.entries(byPair)) {
    const [a, b] = pairKey.split('|')
    let ordered: string[] | null = eghs
    if (eghs.length > 1) {
      const children: SplitChild<string>[] = eghs.map((egh) => ({
        item: egh,
        key: edgeOrderKey(oc, scope, edgeShapes[egh]),
      }))
      ordered = orderSplitChildren(children)  // null on a near-tie -> leave unnamed
    }
    if (ordered === null) continue
    ordered.forEach((egh, i) => {
      const uuid = deriveEdgeUuid(a, b, eghs.length > 1 ? i : 0)
      edgeNames[egh] = uuid
      const tokens: string[] = []
      for (const fu of [a, b]) for (const t of faceAncestry[fu] ?? []) if (!tokens.includes(t)) tokens.push(t)
      edgeAncestry[uuid] = tokens
    })
  }
  return { edgeNames, edgeAncestry }
}
