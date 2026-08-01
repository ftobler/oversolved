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
import { mintFaceUuid, importedFacePath } from '../constructionName'
import { deriveEdgeNames, nameFacesFromNeighbours } from './constructionLineage'

export interface ImportedNameMaps {
  faceNames: Record<string, string>
  edgeNames: Record<string, string>
  faceAncestry: Record<string, string[]>
  edgeAncestry: Record<string, string[]>
}

/**
 * Name every face of an imported `shape` from its STEP entity id, then derive
 * the edges from the face pairs the way every other producer does.
 *
 * `faceStepIds` is keyed by `faceGh` as the explorer over `shape` hashes it --
 * the same key `bodySplit.namesForSolid` and `tessellation.classifyFace` look
 * names up by.
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
  faceStepIds: Record<string, number>,
  createdBy: string,
): ImportedNameMaps {
  const faceNames: Record<string, string> = {}
  const faceAncestry: Record<string, string[]> = {}
  for (const [gh, entityId] of Object.entries(faceStepIds)) {
    const uuid = mintFaceUuid(importedFacePath(createdBy, entityId))
    faceNames[gh] = uuid
    faceAncestry[uuid] = []
  }

  // A face the transfer map did not cover (a sewn or healed face, or a shell
  // the reader rebuilt) is named off its named neighbours instead, so the edges
  // around it do not all fall back to the body-wide ancestral string. Must run
  // before `deriveEdgeNames`, which needs both faces of an edge named.
  nameFacesFromNeighbours(oc, scope, shape, faceNames, faceAncestry)

  const { edgeNames, edgeAncestry } = deriveEdgeNames(oc, scope, shape, faceNames, faceAncestry)
  return { faceNames, edgeNames, faceAncestry, edgeAncestry }
}
