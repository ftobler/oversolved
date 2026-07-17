// Rebuild a body's per-face and per-edge construction names after a boolean op.
//
// Pre-boolean, the target body and tool carry per-face construction UUIDs. After the boolean the
// OCC handles change, so the geom-hash keys go stale. `transferBooleanNames` re-derives them by
// subshape identity (faceOrigin), carrying each source face's UUID onto its output face(s).

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape, OccSubShape } from '../occ/occTypes'
import { faceGh } from '../occ/lineageHash'
import { mintFaceUuid, splitFacePath, orderSplitChildren, type SplitChild } from '../constructionName'
import { deriveEdgeNames, faceSplitKey } from '../occ/constructionLineage'
import type { FaceOrigin } from '../occ/booleans'

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
