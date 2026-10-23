// Construction names for imported (STEP) geometry.
//
// Imported geometry has no construction history in THIS system: no sketch edges
// to inherit ancestor tokens from, and spatial classifiers only fire at the
// bounding-box extremes. Everything else collapsed onto the body-wide ancestral
// string `@<feature>@<body>`, identical for every such face, so picking one
// matched all of them (`AmbiguousQueryError`, "Query matched 56 elements").
//
// The file IS the missing history: a face arrives as `#17=ADVANCED_FACE(...)`,
// and that id is symbolic, position- and scale-independent, and stable across
// re-reads. `stepIo.stepBytesToShapeWithIdentity` recovers it; this module turns
// it into the same four name maps every other producer emits.

import type { DisposeScope } from './disposeScope'
import type { OccModule, OccShape } from './occTypes'
import { mintFaceUuid, importedInstanceFacePath } from '../constructionName'
import { nameNeighboursAndDeriveEdges } from './constructionLineage'
import { canonicalFaces, type ShapeNames } from './bodyNames'
import { SubShapeMap } from './subshapeIdentity'

export type ImportedNameMaps = ShapeNames

/**
 * Per face: which split solid of the import it belongs to. The caller hands in
 * `splitSolids` (features/bodySplit.ts) so the index is the SAME order
 * `registerSplitBodies` names the sibling bodies with (`body_x_1`'s faces carry
 * index 1), and a near-tie refusal falls back the same way body ids do. A face
 * with no entry (a shell-only shape has no solids) defaults to 0.
 */
function solidIndexByFace(oc: OccModule, scope: DisposeScope, solids: OccShape[]): SubShapeMap<number> {
  const out = new SubShapeMap<number>()
  solids.forEach((solid, i) => {
    for (const face of canonicalFaces(oc, scope, solid)) if (!out.has(face)) out.set(face, i)
  })
  return out
}

/**
 * Name every face of an imported `shape` from its STEP entity id, then derive
 * the edges from the face pairs the way every other producer does.
 *
 * `faceStepIds` is keyed by the faces of `shape` as its explorer walk yields
 * them.
 *
 * `solids` is the `splitSolids` order of `shape`. A repeated assembly instance
 * (one part placed twice) shares its STEP entity ids, so without a per-solid
 * index both copies would mint the SAME UUIDs and the resolver's UUID tier
 * would throw "collision by construction" on every pick -- `@<bodyId>` is only
 * consulted by the ancestral tier, which the UUID tier never reaches.
 *
 * The ancestry of an imported face is deliberately EMPTY. The `@u|<uuid>` token
 * resolves in the UUID tier before ancestry is consulted, `buildFaceQuery` skips
 * an empty `ancestorTokens` list, and an imported face genuinely has no ancestor
 * inside this document -- inventing one would put a token in the query that
 * nothing else can ever match.
 */
export function importedNameMaps(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  faceStepIds: SubShapeMap<number>,
  createdBy: string,
  solids: OccShape[],
): ImportedNameMaps {
  const solidIndex = solidIndexByFace(oc, scope, solids)
  const faceNames = new SubShapeMap<string>()
  const faceAncestry: Record<string, string[]> = {}
  for (const face of canonicalFaces(oc, scope, shape)) {
    const entityId = faceStepIds.get(face)
    if (entityId === undefined) continue
    const uuid = mintFaceUuid(importedInstanceFacePath(createdBy, entityId, solidIndex.get(face) ?? 0))
    faceNames.set(face, uuid)
    faceAncestry[uuid] = []
  }

  // A face the transfer map did not cover (a sewn or healed face, or a shell
  // the reader rebuilt) is named off its named neighbours instead, so the edges
  // around it do not all fall back to the body-wide ancestral string. Must run
  // before the edge derivation, which needs both faces of an edge named.
  const { edgeNames, edgeAncestry } = nameNeighboursAndDeriveEdges(oc, scope, shape, faceNames, faceAncestry)
  return { faceNames, edgeNames, faceAncestry, edgeAncestry, capAncestry: {} }
}
