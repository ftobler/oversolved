// Rebuild a body's per-face and per-edge construction names after a boolean op.
//
// Pre-boolean, the target body and tool carry per-face construction UUIDs keyed by their own
// faces. The boolean makes new faces, so `transferBooleanNames` re-keys them by subshape
// history (faceOrigin), carrying each source face's UUID onto its output face(s).

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape, OccSubShape } from '../occ/occTypes'
import { SubShapeIndexMap } from '../occ/primitives'
import { SubShapeMap } from '../occ/subshapeIdentity'
import type { ShapeNames } from '../occ/bodyNames'
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
  // Target body's pre-boolean face names (its faces -> uuid) + ancestry (uuid -> tokens).
  targetFaceNames: SubShapeMap<string>
  targetFaceAncestry: Record<string, string[]>
  // Per-uuid creators carried in from both sides. `toolCreatedBy` is the tool
  // body's own `created_by`, used when a carried tool UUID has no recorded
  // owner (an older document, or a producer that never recorded one).
  targetFaceOwner?: Record<string, string> | null
  targetEdgeOwner?: Record<string, string> | null
  toolFaceOwner?: Record<string, string> | null
  toolEdgeOwner?: Record<string, string> | null
  toolCreatedBy?: string | null
  // Tool body's face names + ancestry (or null for ops without a named tool).
  toolFaceNames: SubShapeMap<string> | null
  toolFaceAncestry: Record<string, string[]> | null
  // Each side's cap identification nets (Body.face_cap_ancestry), carried onto
  // the output face by the same origin mapping. They stay out of faceAncestry
  // so a cap's whole-profile list never becomes an edge's lineage.
  targetCapAncestry?: Record<string, string[]> | null
  toolCapAncestry?: Record<string, string[]> | null
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
): ShapeNames {
  const {
    bodyShape, faceOrigin, targetFaceNames, targetFaceAncestry,
    toolFaceNames, toolFaceAncestry, targetCapAncestry, toolCapAncestry, toolUuidScope,
    targetFaceOwner, toolFaceOwner, toolCreatedBy,
  } = input

  // One Face_1 proxy per distinct sub-shape identity, not per origin entry: a
  // split source appears in faceOrigin once per child, and the output of a
  // merge once per contributing source, so both key spaces repeat (L7).
  // PLACEMENT-SENSITIVE on purpose -- plain IsSame semantics, the opposite of
  // Change 2's placement-stripped unplacer index that looks identical:
  // stripping would collapse two distinct placed faces onto one cell.
  const faceIdx = new SubShapeIndexMap()
  const cells: OccSubShape[] = []
  const faceOf = (s: OccSubShape): OccSubShape => {
    const at = faceIdx.get(s)
    if (at >= 0) return cells[at]
    const face = scope.track(oc.TopoDS.Face_1(s as unknown as OccShape)) as OccSubShape
    faceIdx.set(s, cells.push(face) - 1)
    return face
  }

  // source uuid -> [{output, source}], collecting the outputs each source face
  // produced (>1 is a split).
  const bySource = new Map<string, { output: OccSubShape; source: OccSubShape }[]>()
  const ancestryOf: Record<string, string[]> = {}  // source uuid -> ancestral tokens
  const capAncestryOf: Record<string, string[]> = {}  // source uuid -> a cap's profile net
  const ownerOfUuid: Record<string, string> = {}  // source uuid -> the feature that minted it
  const toolUuids = new Set<string>()  // uuids whose face is tool-side this transfer
  const seenOutput = new SubShapeMap<true>()  // dedupe merged faces by output identity
  for (const o of faceOrigin) {
    const names = o.fromTool ? toolFaceNames : targetFaceNames
    const ancestry = o.fromTool ? toolFaceAncestry : targetFaceAncestry
    const capAncestry = o.fromTool ? toolCapAncestry : targetCapAncestry
    if (!names) continue
    const source = faceOf(o.source)
    const sourceUuid = names.get(source)
    if (!sourceUuid) continue
    // Something else live keeps `sourceUuid`, so this copy takes a scoped one
    // instead of laying a second claim on the same id.
    const uuid = o.fromTool && toolUuidScope !== null
      ? mintFaceUuid(toolCopyFacePath(sourceUuid, toolUuidScope))
      : sourceUuid
    const owner = o.fromTool
      ? toolFaceOwner?.[sourceUuid] ?? toolCreatedBy ?? null
      : targetFaceOwner?.[sourceUuid] ?? null
    if (owner) ownerOfUuid[uuid] = owner
    if (o.fromTool) toolUuids.add(uuid)
    const output = faceOf(o.output)
    if (seenOutput.has(output)) continue
    seenOutput.set(output, true)
    const children = bySource.get(uuid)
    if (children === undefined) bySource.set(uuid, [{ output, source }])
    else children.push({ output, source })
    if (!(uuid in ancestryOf)) ancestryOf[uuid] = [...((ancestry ?? {})[sourceUuid] ?? [])]
    // A cap stays a cap when its UUID is carried: the output face's profile net
    // is the source's. A split child keeps it too (both children bound the same
    // profile entities).
    if (!(uuid in capAncestryOf) && capAncestry?.[sourceUuid]) capAncestryOf[uuid] = [...capAncestry[sourceUuid]]
  }

  const faceNames = new SubShapeMap<string>()
  const faceAncestry: Record<string, string[]> = {}
  const capAncestry: Record<string, string[]> = {}
  const faceOwner: Record<string, string> = {}
  for (const [uuid, children] of bySource) {
    if (children.length === 1) {
      faceNames.set(children[0].output, uuid)
      faceAncestry[uuid] = ancestryOf[uuid]
      if (capAncestryOf[uuid]) capAncestry[uuid] = capAncestryOf[uuid]
      if (ownerOfUuid[uuid]) faceOwner[uuid] = ownerOfUuid[uuid]
      continue
    }
    // Genuine split: order the children in the parent frame; refuse on near-tie.
    const parent = children[0].source
    const ordered = orderSplitChildren(
      children.map<SplitChild<OccSubShape>>((c) => ({
        item: c.output,
        key: faceSplitKey(oc, scope, parent, c.output),
      })),
    )
    if (ordered === null) continue  // ambiguous -> ancestral fallback
    ordered.forEach((out, i) => {
      const childUuid = mintFaceUuid(splitFacePath(uuid, i))
      faceNames.set(out, childUuid)
      faceAncestry[childUuid] = ancestryOf[uuid]
      if (capAncestryOf[uuid]) capAncestry[childUuid] = capAncestryOf[uuid]
      if (ownerOfUuid[uuid]) faceOwner[childUuid] = ownerOfUuid[uuid]
    })
  }

  // A face with no named source (a tool that carried no names, or a near-tie
  // split refusal above) is named off its named neighbours, so the edges around
  // it do not all collapse onto the body-wide ancestral fallback.
  const { edgeNames, edgeAncestry, edgeOwner: derivedEdgeOwner } = nameNeighboursAndDeriveEdges(
    oc, scope, bodyShape, faceNames, faceAncestry,
    undefined,
    { faceOwner, prefer: toolUuids },
  )
  // A carried target or tool edge UUID keeps the owner it had; an edge this
  // operation created (or one whose faces the transfer renamed) takes the
  // face-side owner, with the tool winning a target-versus-tool boundary.
  // Recorded entries are applied last: a carried UUID's owner is authoritative,
  // and a new edge uuid cannot collide with a carried one.
  const edgeOwner: Record<string, string> = { ...derivedEdgeOwner }
  for (const uuid of edgeNames.entries()) {
    const recorded = input.targetEdgeOwner?.[uuid[1]] ?? input.toolEdgeOwner?.[uuid[1]]
    if (recorded) edgeOwner[uuid[1]] = recorded
  }
  return { faceNames, edgeNames, faceAncestry, edgeAncestry, capAncestry, faceOwner, edgeOwner }
}
