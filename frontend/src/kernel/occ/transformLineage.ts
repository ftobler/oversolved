// Construction-name transfer for transformed shape copies (array/mirror/transform
// leaves). A rigid transform/mirror/rotation creates a new topological copy of
// the source body, so the source face UUIDs must be remapped to instance-specific
// UUIDs (and re-keyed onto the copy's own faces) before the copies are fused or
// exposed as separate bodies. Without this, identical array instances share the
// same face/edge UUIDs and their queries collide.

import { type DisposeScope } from './disposeScope'
import type { OccModule, OccShape, OccSubShape, OccTrsf, OccTransformBuilder } from './occTypes'
import { deriveEdgeNames, FaceEdgeTable } from './constructionLineage'
import { mintFaceUuid, arrayInstancePath } from '../constructionName'
import { drainList } from './disposeScope'
import { unplacer, SubShapeIndexMap } from './primitives'
import { SubShapeMap } from './subshapeIdentity'
import type { ShapeNames } from './bodyNames'

export interface FaceNameMaps {
  faceNames: SubShapeMap<string>
  faceAncestry: Record<string, string[]>
  // Cap identification nets keyed by the mapped face uuid (Body.face_cap_ancestry).
  capAncestry: Record<string, string[]>
}

export type NameMaps = ShapeNames

export interface SourceFaceRow {
  face: OccSubShape
  uuid: string  // only faces that HAVE a source uuid are kept
  ancestry: string[]
  // A cap's own profile net, carried apart from `ancestry` (see ShapeNames).
  capAncestry: string[] | null
}

/**
 * The source faces that carry a construction UUID, read once for a whole
 * array/mirror. Identical for every instance: the source shape does not change
 * between them, so reading it per instance was pure repetition (M37). Rows are
 * in explorer order.
 */
export function readSourceFaceRows(
  oc: OccModule, scope: DisposeScope, sourceShape: OccShape,
  sourceFaceNames: SubShapeMap<string>, sourceFaceAncestry: Record<string, string[]>,
  sourceCapAncestry: Record<string, string[]> = {},
): SourceFaceRow[] {
  const E = oc.TopAbs_ShapeEnum
  const sourceExp = scope.track(new oc.TopExp_Explorer_2(sourceShape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  const rows: SourceFaceRow[] = []
  for (; sourceExp.More(); sourceExp.Next()) {
    const raw = scope.track(sourceExp.Current())
    const sourceFace = scope.track(oc.TopoDS.Face_1(raw)) as OccSubShape
    const sourceUuid = sourceFaceNames.get(sourceFace)
    if (!sourceUuid) continue
    rows.push({
      face: sourceFace,
      uuid: sourceUuid,
      ancestry: sourceFaceAncestry[sourceUuid] ?? [],
      capAncestry: sourceCapAncestry[sourceUuid] ?? null,
    })
  }
  return rows
}

/**
 * Apply a gp_Trsf to a shape with copy=true and expose the builder's subshape
 * mapping so source faces can be mapped to their transformed images.
 */
export function transformCopyWithMapping(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  trsf: OccTrsf,
): { shape: OccShape; builder: OccTransformBuilder } {
  const builder = scope.track(new oc.BRepBuilderAPI_Transform_2(shape, trsf, true))
  builder.Build()
  if (!builder.IsDone()) throw new Error('transform builder did not complete')
  return { shape: builder.Shape(), builder }
}

/**
 * Remap a source body's face UUIDs to instance-specific UUIDs and re-key them
 * onto the transformed shape's own faces. `builder` is the transform
 * builder that produced `instanceShape`; `Modified()` maps each source face to
 * its transformed image in the builder's forward orientation. The transformed
 * image and the shell-oriented instance face share the same TShape (only
 * orientation may differ), so we match on the placement-stripped identity to
 * obtain the key downstream consumers will use.
 */
export function remapFaceNamesForInstance(
  oc: OccModule,
  scope: DisposeScope,
  instanceShape: OccShape,
  rows: SourceFaceRow[],
  featureId: string,
  index: number,
  builder: OccTransformBuilder,
): FaceNameMaps {
  const E = oc.TopAbs_ShapeEnum
  const faceNames = new SubShapeMap<string>()
  const faceAncestry: Record<string, string[]> = {}
  const capAncestry: Record<string, string[]> = {}

  // Cache shell-oriented instance faces so each source face's image can be
  // matched to the outward-facing explorer order used by downstream code.
  const instanceFaces: OccSubShape[] = []
  const instanceExp = scope.track(new oc.TopExp_Explorer_2(instanceShape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  for (; instanceExp.More(); instanceExp.Next()) {
    const raw = scope.track(instanceExp.Current())
    instanceFaces.push(scope.track(oc.TopoDS.Face_1(raw)) as OccSubShape)
  }

  // Placement-stripped face -> index. HashCode folds in the TopLoc_Location, so
  // the placed image would land in a different bucket than its shell twin;
  // stripping both sides gives the IsPartner-equivalent match in O(1) instead
  // of the O(F) IsPartner scan it replaces (M37 Change 2b). `keep` copies stay
  // live on this scope because the index holds them; the lookup side borrows.
  const unplaced = unplacer(oc, scope)
  const instanceIdx = new SubShapeIndexMap()
  instanceFaces.forEach((f, i) => instanceIdx.set(unplaced.keep(f), i))

  for (const row of rows) {
    const transformed = drainList(scope, builder.Modified(row.face))
    for (const t of transformed) {
      const tFace = scope.track(oc.TopoDS.Face_1(t)) as OccSubShape
      const j = unplaced.borrow(tFace, (bare) => instanceIdx.get(bare))
      if (j < 0) throw new Error('transformed source face has no shell-oriented partner')
      const match = instanceFaces[j]
      const newUuid = mintFaceUuid(arrayInstancePath(row.uuid, featureId, index))
      faceNames.set(match, newUuid)
      faceAncestry[newUuid] = [...row.ancestry]
      if (row.capAncestry) capAncestry[newUuid] = [...row.capAncestry]
    }
  }
  return { faceNames, faceAncestry, capAncestry }
}

/**
 * Re-key a body's existing face UUIDs onto the transformed shape's own faces
 * without minting new UUIDs. Used for in-place transforms where the
 * construction path does not change (e.g. a pure translation/rotation that
 * keeps the same body), so existing face queries keep resolving.
 */
export function rekeyFaceNamesForTransform(
  oc: OccModule,
  scope: DisposeScope,
  transformedShape: OccShape,
  sourceShape: OccShape,
  sourceFaceNames: SubShapeMap<string>,
  sourceFaceAncestry: Record<string, string[]>,
  builder: OccTransformBuilder,
  sourceCapAncestry: Record<string, string[]> = {},
): FaceNameMaps {
  const E = oc.TopAbs_ShapeEnum
  const faceNames = new SubShapeMap<string>()
  const faceAncestry: Record<string, string[]> = {}
  const capAncestry: Record<string, string[]> = {}

  const transformedFaces: OccSubShape[] = []
  const texp = scope.track(new oc.TopExp_Explorer_2(transformedShape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  for (; texp.More(); texp.Next()) {
    const raw = scope.track(texp.Current())
    transformedFaces.push(scope.track(oc.TopoDS.Face_1(raw)) as OccSubShape)
  }

  // Same placement-stripped index as remapFaceNamesForInstance (Change 2b): the
  // forward-oriented image and the shell-oriented face share a TShape under
  // different placements, so the stripped identity is the IsPartner-equivalent
  // key. The two identity semantics 200 lines apart must not be confused with
  // Changes 3c/4b's placement-SENSITIVE SubShapeIndexMap keys.
  const unplaced = unplacer(oc, scope)
  const transformedIdx = new SubShapeIndexMap()
  transformedFaces.forEach((f, i) => transformedIdx.set(unplaced.keep(f), i))

  const sourceExp = scope.track(new oc.TopExp_Explorer_2(sourceShape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  for (; sourceExp.More(); sourceExp.Next()) {
    const raw = scope.track(sourceExp.Current())
    const sourceFace = scope.track(oc.TopoDS.Face_1(raw)) as OccSubShape
    const sourceUuid = sourceFaceNames.get(sourceFace)
    if (!sourceUuid) continue
    const transformed = drainList(scope, builder.Modified(sourceFace))
    for (const t of transformed) {
      const tFace = scope.track(oc.TopoDS.Face_1(t)) as OccSubShape
      const j = unplaced.borrow(tFace, (bare) => transformedIdx.get(bare))
      if (j < 0) throw new Error('transformed source face has no shell-oriented partner')
      const match = transformedFaces[j]
      faceNames.set(match, sourceUuid)
      faceAncestry[sourceUuid] = [...(sourceFaceAncestry[sourceUuid] ?? [])]
      if (sourceCapAncestry[sourceUuid]) capAncestry[sourceUuid] = [...sourceCapAncestry[sourceUuid]]
    }
  }
  return { faceNames, faceAncestry, capAncestry }
}

/**
 * Re-key a body's full construction-name maps after an in-place transform.
 * Face UUIDs are preserved; edges are re-derived from the new face adjacency.
 */
export function rekeyNamesForTransformedBody(
  oc: OccModule,
  scope: DisposeScope,
  transformedShape: OccShape,
  sourceShape: OccShape,
  sourceNames: NameMaps,
  builder: OccTransformBuilder,
): NameMaps {
  const face = rekeyFaceNamesForTransform(
    oc,
    scope,
    transformedShape,
    sourceShape,
    sourceNames.faceNames,
    sourceNames.faceAncestry,
    builder,
    sourceNames.capAncestry,
  )
  // Edge derivation only (no neighbour pass on a rigid transform: every face is
  // already named by the rekey); the table is read once and handed in.
  const t = FaceEdgeTable.read(oc, scope, transformedShape)
  const { edgeNames, edgeAncestry } = deriveEdgeNames(oc, scope, t, face.faceNames, face.faceAncestry)
  return { ...face, edgeNames, edgeAncestry }
}

/**
 * Build full construction-name maps for a transformed copy: face UUIDs remapped
 * to the instance, edges derived from the new face adjacency. This is the name
 * set a `transform`/`mirror`/`array` new-body or the non-source instances of an
 * add-fuse array should carry.
 */
export function rebuildNamesForTransformedCopy(
  oc: OccModule,
  scope: DisposeScope,
  instanceShape: OccShape,
  rows: SourceFaceRow[],
  featureId: string,
  index: number,
  builder: OccTransformBuilder,
): NameMaps {
  const face = remapFaceNamesForInstance(oc, scope, instanceShape, rows, featureId, index, builder)
  // Edge derivation only (no neighbour pass on a rigid transform: every face is
  // already named by the remap); the table is read once and handed in.
  const t = FaceEdgeTable.read(oc, scope, instanceShape)
  const { edgeNames, edgeAncestry } = deriveEdgeNames(oc, scope, t, face.faceNames, face.faceAncestry)
  return { ...face, edgeNames, edgeAncestry }
}
