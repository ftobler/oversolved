// Rebuild a body's per-face and per-edge lineage after a boolean op.
//
// Pre-boolean, the target body and tool carry per-entity lineage tokens keyed by face geometry
// hash. After the boolean the OCC handles change, so those keys go stale. This re-derives them
// geometrically: - inherited output faces (target lineage survives) match against the
// pre-boolean target faces; copy the target body's tokens. - new output faces (introduced by
// the tool) match against the tool faces; copy the tool's tokens. - edge_lineage is rebuilt
// from face_lineage via edge->face adjacency.
//
// Lineage is keyed by face_geometry_hash (see lineage-stable-keying.md), so we match on
// geometry, not the copy-fragile subshape hash. The edge->face adjacency is built face-by-face:
// opencascade.js@1.1.1 lacks TopTools_IndexedDataMapOfShapeListOfShape, so Python's
// MapShapesAndAncestors path is unavailable.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape, OccSubShape } from '../occ/occTypes'
import type { BrepDiff } from '../types3d'
import { faceCentroid, faceNormal, faceArea, type Vec3 } from '../occ/primitives'
import { faceGeometryHash } from '../geomHash'
import { faceGh, edgeGh } from '../occ/lineageHash'
import { mintFaceUuid, splitFacePath, orderSplitChildren, type SplitChild } from '../constructionName'
import { deriveEdgeNames, faceSplitKey } from '../occ/constructionLineage'
import type { FaceOrigin } from '../occ/booleans'

interface FaceGeom {
  face: OccShape
  centroid: Vec3
  area: number
  normal: Vec3
}

/** [(face, centroid, area, normal), ...] for every face of a shape. */
function faceGeometryList(oc: OccModule, scope: DisposeScope, shape: OccShape): FaceGeom[] {
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  const out: FaceGeom[] = []
  for (; exp.More(); exp.Next()) {
    const face = scope.track(oc.TopoDS.Face_1(exp.Current()))
    out.push({
      face,
      centroid: faceCentroid(oc, scope, face),
      area: faceArea(oc, scope, face),
      normal: faceNormal(oc, scope, face),
    })
  }
  return out
}

/**
 * Closest geometric match to `face` among `candidates` (mirrors
 * `_find_best_face_match`): score = centroid distance + 0.01*relative-area-diff
 * + 0.001*(1 - |normal . normal|); accept only if score < 1.0 (virtually
 * identical). Returns the matched candidate, or null.
 */
function findBestFaceMatch(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  candidates: FaceGeom[],
): FaceGeom | null {
  if (candidates.length === 0) return null
  const fc = faceCentroid(oc, scope, face)
  const fn = faceNormal(oc, scope, face)
  const fa = faceArea(oc, scope, face)
  let best: FaceGeom | null = null
  let bestScore = Infinity
  for (const cand of candidates) {
    const cc = cand.centroid
    const cn = cand.normal
    const ca = cand.area
    const dc = Math.sqrt((fc[0] - cc[0]) ** 2 + (fc[1] - cc[1]) ** 2 + (fc[2] - cc[2]) ** 2)
    const ar = Math.abs(fa - ca) / Math.max(fa, ca, 1e-12)
    const dn = 1.0 - Math.abs(fn[0] * cn[0] + fn[1] * cn[1] + fn[2] * cn[2])
    const score = dc + 0.01 * ar + 0.001 * dn
    if (score < bestScore) {
      bestScore = score
      best = cand
    }
  }
  return best !== null && bestScore < 1.0 ? best : null
}

interface TransferLineageInput {
  /** The body's shape AFTER the boolean (cleaned). */
  bodyShape: OccShape
  /** The boolean's BrepDiff (cleaned-space face/edge handles). */
  diff: BrepDiff
  /** The target body's shape BEFORE the boolean. */
  oldTargetShape: OccShape
  /** The tool shape (or null for ops without one). */
  toolShape: OccShape | null
  /** The target body's pre-boolean face lineage (face_gh -> tokens). */
  faceLineage: Record<string, string[]>
  /** The tool's face lineage (face_gh -> tokens), or null. */
  toolFaceLineage: Record<string, string[]> | null
}

/**
 * Rebuilt (face_lineage, edge_lineage) for a body after a boolean op. Pure
 * w.r.t. the body object (caller assigns the result), mirroring
 * `_transfer_boolean_lineage`'s mutation of body.face_lineage/edge_lineage.
 */
export function transferBooleanLineage(
  oc: OccModule,
  scope: DisposeScope,
  input: TransferLineageInput,
): { face_lineage: Record<string, string[]>; edge_lineage: Record<string, string[]> } {
  const { bodyShape, diff, oldTargetShape, toolShape, faceLineage, toolFaceLineage } = input

  const targetFaceList = faceGeometryList(oc, scope, oldTargetShape)
  const toolFaceList = toolShape ? faceGeometryList(oc, scope, toolShape) : []

  const newFaceLineage: Record<string, string[]> = {}

  const candidateGh = (cand: FaceGeom): string => faceGeometryHash(cand.centroid, cand.normal)

  // The diff carries raw TopoDS_Shape handles; cast to TopoDS_Face for the
  // surface-adaptor geometry reads (BRepAdaptor_Surface needs a Face).
  const asFace = (s: OccShape): OccShape => scope.track(oc.TopoDS.Face_1(s))

  // Inherited faces: match against the target body's pre-boolean faces.
  if (diff.inherited_faces.length && Object.keys(faceLineage).length) {
    for (const raw of diff.inherited_faces as OccShape[]) {
      const outputFace = asFace(raw)
      const src = findBestFaceMatch(oc, scope, outputFace, targetFaceList)
      if (src) {
        const tokens = faceLineage[candidateGh(src)]
        if (tokens && tokens.length) {
          newFaceLineage[faceGh(oc, scope, outputFace)] = tokens
        }
      }
    }
  }

  // New faces: match against the tool shape's faces.
  if (diff.new_faces.length && toolFaceLineage && Object.keys(toolFaceLineage).length) {
    for (const raw of diff.new_faces as OccShape[]) {
      const outputFace = asFace(raw)
      const src = findBestFaceMatch(oc, scope, outputFace, toolFaceList)
      if (src) {
        const tokens = toolFaceLineage[candidateGh(src)]
        if (tokens && tokens.length) {
          newFaceLineage[faceGh(oc, scope, outputFace)] = tokens
        }
      }
    }
  }

  // Rebuild edge_lineage from face_lineage via edge->face adjacency. Build the
  // adjacency face-by-face (no indexed data map in this OCC build): for each
  // face, walk its edges and accumulate that face's tokens onto the edge's hash.
  const newEdgeLineage: Record<string, string[]> = {}
  const E = oc.TopAbs_ShapeEnum
  const faceExp = scope.track(new oc.TopExp_Explorer_2(bodyShape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  for (; faceExp.More(); faceExp.Next()) {
    const face = scope.track(oc.TopoDS.Face_1(faceExp.Current()))
    const fgh = faceGh(oc, scope, face)
    const faceTokens = newFaceLineage[fgh]
    if (!faceTokens || faceTokens.length === 0) continue
    const edgeExp = scope.track(new oc.TopExp_Explorer_2(face, E.TopAbs_EDGE, E.TopAbs_SHAPE))
    for (; edgeExp.More(); edgeExp.Next()) {
      const edge = scope.track(oc.TopoDS.Edge_1(edgeExp.Current()))
      const egh = edgeGh(oc, scope, edge)
      if (egh === null) continue
      const existing = newEdgeLineage[egh] ?? []
      for (const eid of faceTokens) {
        if (!existing.includes(eid)) existing.push(eid)
      }
      newEdgeLineage[egh] = existing
    }
  }

  return { face_lineage: newFaceLineage, edge_lineage: newEdgeLineage }
}

// ─── construction-name transfer (query-naming-by-construction) ───

interface TransferNamesInput {
  /** The body's shape AFTER the boolean (cleaned) -- the faceOrigin output space. */
  bodyShape: OccShape
  /** Per-output-face origin from booleanWithDiff. */
  faceOrigin: FaceOrigin[]
  /** Target body's pre-boolean face names (face_gh -> uuid) + ancestry (uuid -> tokens). */
  targetFaceNames: Record<string, string>
  targetFaceAncestry: Record<string, string[]>
  /** Tool body's face names + ancestry (or null for ops without a named tool). */
  toolFaceNames: Record<string, string> | null
  toolFaceAncestry: Record<string, string[]> | null
}

/**
 * Rebuilt construction-name maps for a body after a boolean, carrying each
 * source face's UUID onto its output face(s) by subshape identity (faceOrigin),
 * NOT geometry. A source that maps to several outputs is a genuine split: those
 * children are ordered by their relative position in the parent frame and get
 * `:split:i` UUIDs; a near-tie refuses (fail-safe, ancestral fallback). Edge
 * names are then derived from the output face adjacency.
 */
export function transferBooleanNames(
  oc: OccModule,
  scope: DisposeScope,
  input: TransferNamesInput,
): {
  face_names: Record<string, string>
  edge_names: Record<string, string>
  face_ancestry: Record<string, string[]>
  edge_ancestry: Record<string, string[]>
} {
  const { bodyShape, faceOrigin, targetFaceNames, targetFaceAncestry, toolFaceNames, toolFaceAncestry } = input

  // faceOrigin handles are generic TopoDS_Shape; downcast to Face for the
  // surface-adaptor geometry reads faceGh/faceSplitKey need.
  const asFace = (s: OccSubShape): OccShape => scope.track(oc.TopoDS.Face_1(s as unknown as OccShape))

  // source uuid -> [{output, source}], collecting the outputs each source face
  // produced (>1 is a split).
  const bySource: Record<string, { output: OccShape; source: OccShape }[]> = {}
  const ancestryOf: Record<string, string[]> = {}  // source uuid -> ancestral tokens
  const seenOutput = new Set<string>()  // dedupe merged faces by output gh
  for (const o of faceOrigin) {
    const names = o.fromTool ? toolFaceNames : targetFaceNames
    const ancestry = o.fromTool ? toolFaceAncestry : targetFaceAncestry
    if (!names) continue
    const source = asFace(o.source)
    const uuid = names[faceGh(oc, scope, source)]
    if (!uuid) continue
    const output = asFace(o.output)
    const outGh = faceGh(oc, scope, output)
    if (seenOutput.has(outGh)) continue
    seenOutput.add(outGh)
    ;(bySource[uuid] ??= []).push({ output, source })
    if (!(uuid in ancestryOf)) ancestryOf[uuid] = [...((ancestry ?? {})[uuid] ?? [])]
  }

  const faceNames: Record<string, string> = {}
  const faceAncestry: Record<string, string[]> = {}
  for (const [uuid, children] of Object.entries(bySource)) {
    if (children.length === 1) {
      faceNames[faceGh(oc, scope, children[0].output)] = uuid
      faceAncestry[uuid] = ancestryOf[uuid]
      continue
    }
    // Genuine split: order the children in the parent frame; refuse on near-tie.
    const parent = children[0].source
    const ordered = orderSplitChildren(
      children.map<SplitChild<OccShape>>((c) => ({
        item: c.output,
        key: faceSplitKey(oc, scope, parent, c.output),
      })),
    )
    if (ordered === null) continue  // ambiguous -> ancestral fallback
    ordered.forEach((out, i) => {
      const childUuid = mintFaceUuid(splitFacePath(uuid, i))
      faceNames[faceGh(oc, scope, out)] = childUuid
      faceAncestry[childUuid] = ancestryOf[uuid]
    })
  }

  const { edgeNames, edgeAncestry } = deriveEdgeNames(oc, scope, bodyShape, faceNames, faceAncestry)
  return { face_names: faceNames, edge_names: edgeNames, face_ancestry: faceAncestry, edge_ancestry: edgeAncestry }
}
