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
import {
  deriveEdgeUuid,
  deriveSeamEdgeUuid,
  deriveCornerFaceUuid,
  orderSplitChildren,
  type SplitChild,
} from '../constructionName'

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
 * Name the faces the producer left unnamed, from the set of their NAMED
 * neighbours (`deriveCornerFaceUuid`) -- the face analogue of the vertex rule in
 * `vertexUuidsFromFaces`. Must run BEFORE `deriveEdgeNames`, whose derivation
 * needs both of an edge's faces named.
 *
 * The case that forced it: where several fillet blends meet, OCC grows a corner
 * patch that is `Generated()` from a VERTEX, not from any filleted edge, so the
 * modifier's edge-driven naming cannot reach it. The patch stayed unnamed, and
 * with it every edge around it -- and an unnamed edge falls back to the body's
 * `createdBy + bodyId + profile_queries` ancestral string, which is IDENTICAL
 * for every unnamed edge on the body. Picks on those edges resolved to whichever
 * sibling classifiers happened to separate, or ambiguously to all of them. See
 * `bugreports/edge_resolves_not_unique_20260728_213049.md`.
 *
 * Mutates `faceNames`/`faceAncestry` in place, only adding faces that had no
 * name -- a producer-minted UUID is never rewritten. Neighbours are read from
 * the pre-pass name set, so no residual name is derived from another residual
 * name and the result is independent of face iteration order.
 */
export function nameFacesFromNeighbours(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  faceNames: Record<string, string>,
  faceAncestry: Record<string, string[]>,
): void {
  const E = oc.TopAbs_ShapeEnum
  const faces: { gh: string; face: OccShape; edges: string[] }[] = []
  const facesOnEdge: Record<string, Set<string>> = {}  // edge gh -> face ghs touching it
  const seen = new Set<string>()
  const faceExp = scope.track(new oc.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  for (; faceExp.More(); faceExp.Next()) {
    const face = scope.track(oc.TopoDS.Face_1(faceExp.Current()))
    const gh = faceGh(oc, scope, face)
    if (seen.has(gh)) continue
    seen.add(gh)
    const edges: string[] = []
    const eExp = scope.track(new oc.TopExp_Explorer_2(face, E.TopAbs_EDGE, E.TopAbs_SHAPE))
    for (; eExp.More(); eExp.Next()) {
      const egh = edgeGh(oc, scope, scope.track(oc.TopoDS.Edge_1(eExp.Current())))
      if (egh === null) continue
      edges.push(egh)
      ;(facesOnEdge[egh] ??= new Set()).add(gh)
    }
    faces.push({ gh, face, edges })
  }

  type Residual = { gh: string; face: OccShape }
  const bySet: Record<string, Residual[]> = {}  // "uuidA|uuidB|..." -> residual faces
  for (const f of faces) {
    if (f.gh in faceNames) continue
    const neighbours = new Set<string>()
    for (const egh of f.edges) {
      for (const other of facesOnEdge[egh] ?? []) {
        if (other === f.gh) continue
        const uuid = faceNames[other]
        if (uuid) neighbours.add(uuid)
      }
    }
    if (neighbours.size === 0) continue  // nothing symbolic to name it by
    ;(bySet[[...neighbours].sort().join('|')] ??= []).push({ gh: f.gh, face: f.face })
  }

  for (const [setKey, group] of Object.entries(bySet)) {
    const neighbours = setKey.split('|')
    let ordered: Residual[] | null = group
    if (group.length > 1) {
      ordered = orderSplitChildren(
        group.map<SplitChild<Residual>>((r) => ({ item: r, key: faceCentroid(oc, scope, r.face) })),
      )  // null on a near-tie -> leave unnamed
    }
    if (ordered === null) continue
    ordered.forEach((r, i) => {
      const uuid = deriveCornerFaceUuid(neighbours, group.length > 1 ? i : 0)
      faceNames[r.gh] = uuid
      const tokens: string[] = []
      for (const nu of neighbours) for (const t of faceAncestry[nu] ?? []) if (!tokens.includes(t)) tokens.push(t)
      faceAncestry[uuid] = tokens
    })
  }
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
  const bySingle: Record<string, string[]> = {}  // "uuidA" -> [seam edge gh...]
  for (const [egh, uuidSet] of Object.entries(adjacency)) {
    const distinct = [...uuidSet]
    // Two named faces -> a normal edge; one named face -> a seam edge (e.g. a
    // cylinder's lateral seam). Both must get a UUID so no pickable edge is left
    // with only the ambiguous createdBy+classifiers fallback query.
    if (distinct.length === 2) {
      (byPair[[...distinct].sort().join('|')] ??= []).push(egh)
    } else if (distinct.length === 1) {
      (bySingle[distinct[0]] ??= []).push(egh)
    }
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
  for (const [faceUuid, eghs] of Object.entries(bySingle)) {
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
      const uuid = deriveSeamEdgeUuid(faceUuid, eghs.length > 1 ? i : 0)
      edgeNames[egh] = uuid
      edgeAncestry[uuid] = [...(faceAncestry[faceUuid] ?? [])]
    })
  }
  return { edgeNames, edgeAncestry }
}
