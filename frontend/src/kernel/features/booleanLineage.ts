// Rebuild a body's per-face and per-edge construction names after a boolean op.
//
// Pre-boolean, the target body and tool carry per-face construction UUIDs. After the boolean the
// OCC handles change, so the geom-hash keys go stale. `transferBooleanNames` re-derives them by
// subshape identity (faceOrigin), carrying each source face's UUID onto its output face(s).

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape, OccSubShape } from '../occ/occTypes'
import { SubShapeIndexMap } from '../occ/primitives'
import { faceGh } from '../occ/lineageHash'
import {
  mintFaceUuid,
  splitFacePath,
  toolCopyFacePath,
  orderSplitChildren,
  type SplitChild,
} from '../constructionName'
import { nameNeighboursAndDeriveEdges, faceSplitKey } from '../occ/constructionLineage'
import type { FaceOrigin } from '../occ/booleans'

// ─── construction-name transfer (query-naming-by-construction) ───

interface TransferNamesInput {
  // The body's shape AFTER the boolean (cleaned) -- the faceOrigin output space.
  bodyShape: OccShape
  // Per-output-face origin from booleanWithDiff.
  faceOrigin: FaceOrigin[]
  // Target body's pre-boolean face names (face_gh -> uuid) + ancestry (uuid -> tokens).
  targetFaceNames: Record<string, string>
  targetFaceAncestry: Record<string, string[]>
  // Tool body's face names + ancestry (or null for ops without a named tool).
  toolFaceNames: Record<string, string> | null
  toolFaceAncestry: Record<string, string[]> | null
  // What makes this body's copy of the tool's UUIDs distinct, or null to carry
  // them verbatim. Non-null whenever some OTHER live face keeps the originals:
  // a kept tool body (scope = the boolean), or a sibling target the same cut
  // also reached (scope = this body). Without it one UUID names two faces.
  toolUuidScope: string | null
}

/**
 * Rebuilt construction-name maps for a body after a boolean, carrying each
 * source face's UUID onto its output face(s) by subshape identity (faceOrigin),
 * NOT geometry. A source that maps to several outputs is a genuine split: those
 * children are ordered by their relative position in the parent frame and get
 * `:split:i` UUIDs; a near-tie refuses (fail-safe, ancestral fallback). Edge
 * names are then derived from the output face adjacency.
 *
 * `toolUuidScope` is the exception to the verbatim carry: when something else
 * live still holds those UUIDs (a kept tool body, a sibling target of the same
 * cut) the tool-sourced ones are re-minted under it rather than letting one
 * UUID name two faces.
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
  const {
    bodyShape, faceOrigin, targetFaceNames, targetFaceAncestry,
    toolFaceNames, toolFaceAncestry, toolUuidScope,
  } = input

  // One Face_1 proxy and one faceGh per distinct sub-shape identity, not per
  // origin entry: a split source appears in faceOrigin once per child, and the
  // output of a merge once per contributing source, so both key spaces repeat
  // (L7). PLACEMENT-SENSITIVE on purpose -- plain IsSame semantics, the
  // opposite of Change 2's placement-stripped unplacer index that looks
  // identical: stripping would collapse two distinct placed faces onto one cell.
  const faceIdx = new SubShapeIndexMap()
  const cells: { face: OccShape; gh: string }[] = []
  const cellOf = (s: OccSubShape): { face: OccShape; gh: string } => {
    const at = faceIdx.get(s)
    if (at >= 0) return cells[at]
    const face = scope.track(oc.TopoDS.Face_1(s as unknown as OccShape))
    const cell = { face, gh: faceGh(oc, scope, face) }
    faceIdx.set(s, cells.push(cell) - 1)
    return cell
  }

  // source uuid -> [{output, source, outGh}], collecting the outputs each source
  // face produced (>1 is a split).
  const bySource: Record<string, { output: OccShape; source: OccShape; outGh: string }[]> = {}
  const ancestryOf: Record<string, string[]> = {}  // source uuid -> ancestral tokens
  const seenOutput = new Set<string>()  // dedupe merged faces by output gh
  for (const o of faceOrigin) {
    const names = o.fromTool ? toolFaceNames : targetFaceNames
    const ancestry = o.fromTool ? toolFaceAncestry : targetFaceAncestry
    if (!names) continue
    const sourceCell = cellOf(o.source)
    const sourceUuid = names[sourceCell.gh]
    if (!sourceUuid) continue
    // Something else live keeps `sourceUuid`, so this copy takes a scoped one
    // instead of laying a second claim on the same id.
    const uuid = o.fromTool && toolUuidScope !== null
      ? mintFaceUuid(toolCopyFacePath(sourceUuid, toolUuidScope))
      : sourceUuid
    const outputCell = cellOf(o.output)
    const outGh = outputCell.gh
    if (seenOutput.has(outGh)) continue
    seenOutput.add(outGh)
    ;(bySource[uuid] ??= []).push({ output: outputCell.face, source: sourceCell.face, outGh })
    if (!(uuid in ancestryOf)) ancestryOf[uuid] = [...((ancestry ?? {})[sourceUuid] ?? [])]
  }

  const faceNames: Record<string, string> = {}
  const faceAncestry: Record<string, string[]> = {}
  for (const [uuid, children] of Object.entries(bySource)) {
    if (children.length === 1) {
      faceNames[children[0].outGh] = uuid
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
    const outGhOf = new Map(children.map((c) => [c.output, c.outGh]))
    ordered.forEach((out, i) => {
      const childUuid = mintFaceUuid(splitFacePath(uuid, i))
      faceNames[outGhOf.get(out)!] = childUuid
      faceAncestry[childUuid] = ancestryOf[uuid]
    })
  }

  // A face with no named source (a tool that carried no names, or a near-tie
  // split refusal above) is named off its named neighbours, so the edges around
  // it do not all collapse onto the body-wide ancestral fallback.
  const { edgeNames, edgeAncestry } = nameNeighboursAndDeriveEdges(oc, scope, bodyShape, faceNames, faceAncestry)
  return { face_names: faceNames, edge_names: edgeNames, face_ancestry: faceAncestry, edge_ancestry: edgeAncestry }
}
