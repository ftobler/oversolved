// Construction-name transfer for transformed shape copies (array/mirror/transform
// leaves). A rigid transform/mirror/rotation creates a new topological copy of
// the source body, so the source face UUIDs must be remapped to instance-specific
// UUIDs (and re-keyed by the new geometry hash) before the copies are fused or
// exposed as separate bodies. Without this, identical array instances share the
// same face/edge UUIDs and their queries collide.

import { type DisposeScope } from './disposeScope'
import type { OccModule, OccShape, OccSubShape, OccTrsf, OccTransformBuilder } from './occTypes'
import { faceGh } from './lineageHash'
import { deriveEdgeNames } from './constructionLineage'
import { mintFaceUuid, arrayInstancePath } from '../constructionName'
import { drainList } from './disposeScope'

export interface FaceNameMaps {
  faceNames: Record<string, string>
  faceAncestry: Record<string, string[]>
}

export interface NameMaps extends FaceNameMaps {
  edgeNames: Record<string, string>
  edgeAncestry: Record<string, string[]>
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
  return { shape: builder.Shape(), builder }
}

/**
 * Remap a source body's face UUIDs to instance-specific UUIDs and re-key them
 * by the transformed shape's face geometry hash. `builder` is the transform
 * builder that produced `instanceShape`; `Modified()` maps each source face to
 * its transformed image in the builder's forward orientation. The transformed
 * image and the shell-oriented instance face share the same TShape (only
 * orientation may differ), so we match by `IsPartner` to obtain the key
 * downstream consumers will use.
 */
export function remapFaceNamesForInstance(
  oc: OccModule,
  scope: DisposeScope,
  instanceShape: OccShape,
  sourceShape: OccShape,
  sourceFaceNames: Record<string, string>,
  sourceFaceAncestry: Record<string, string[]>,
  featureId: string,
  index: number,
  builder: OccTransformBuilder,
): FaceNameMaps {
  const E = oc.TopAbs_ShapeEnum
  const faceNames: Record<string, string> = {}
  const faceAncestry: Record<string, string[]> = {}

  // Cache shell-oriented instance faces so each source face's image can be
  // matched to the outward-facing explorer order used by downstream code.
  const instanceFaces: OccSubShape[] = []
  const instanceExp = scope.track(new oc.TopExp_Explorer_2(instanceShape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  for (; instanceExp.More(); instanceExp.Next()) {
    instanceFaces.push(scope.track(oc.TopoDS.Face_1(instanceExp.Current())) as OccSubShape)
  }

  const sourceExp = scope.track(new oc.TopExp_Explorer_2(sourceShape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  for (; sourceExp.More(); sourceExp.Next()) {
    const sourceFace = scope.track(oc.TopoDS.Face_1(sourceExp.Current())) as OccSubShape
    const sourceUuid = sourceFaceNames[faceGh(oc, scope, sourceFace)]
    if (!sourceUuid) continue
    const transformed = drainList(scope, builder.Modified(sourceFace))
    for (const t of transformed) {
      const tFace = scope.track(oc.TopoDS.Face_1(t)) as OccSubShape
      // The builder's forward-oriented image may differ in orientation from the
      // shell-oriented face; IsPartner ignores orientation and matches TShape.
      const match = instanceFaces.find((f) => f.IsPartner(tFace))
      if (!match) throw new Error('transformed source face has no shell-oriented partner')
      const newUuid = mintFaceUuid(arrayInstancePath(sourceUuid, featureId, index))
      faceNames[faceGh(oc, scope, match)] = newUuid
      faceAncestry[newUuid] = [...(sourceFaceAncestry[sourceUuid] ?? [])]
    }
  }
  return { faceNames, faceAncestry }
}

/**
 * Re-key a body's existing face UUIDs by the transformed shape's geometry hash
 * without minting new UUIDs. Used for in-place transforms where the
 * construction path does not change (e.g. a pure translation/rotation that
 * keeps the same body), so existing face queries keep resolving.
 */
export function rekeyFaceNamesForTransform(
  oc: OccModule,
  scope: DisposeScope,
  transformedShape: OccShape,
  sourceShape: OccShape,
  sourceFaceNames: Record<string, string>,
  sourceFaceAncestry: Record<string, string[]>,
  builder: OccTransformBuilder,
): FaceNameMaps {
  const E = oc.TopAbs_ShapeEnum
  const faceNames: Record<string, string> = {}
  const faceAncestry: Record<string, string[]> = {}

  const transformedFaces: OccSubShape[] = []
  const texp = scope.track(new oc.TopExp_Explorer_2(transformedShape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  for (; texp.More(); texp.Next()) {
    transformedFaces.push(scope.track(oc.TopoDS.Face_1(texp.Current())) as OccSubShape)
  }

  const sourceExp = scope.track(new oc.TopExp_Explorer_2(sourceShape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  for (; sourceExp.More(); sourceExp.Next()) {
    const sourceFace = scope.track(oc.TopoDS.Face_1(sourceExp.Current())) as OccSubShape
    const sourceUuid = sourceFaceNames[faceGh(oc, scope, sourceFace)]
    if (!sourceUuid) continue
    const transformed = drainList(scope, builder.Modified(sourceFace))
    for (const t of transformed) {
      const tFace = scope.track(oc.TopoDS.Face_1(t)) as OccSubShape
      const match = transformedFaces.find((f) => f.IsPartner(tFace))
      if (!match) throw new Error('transformed source face has no shell-oriented partner')
      faceNames[faceGh(oc, scope, match)] = sourceUuid
      faceAncestry[sourceUuid] = [...(sourceFaceAncestry[sourceUuid] ?? [])]
    }
  }
  return { faceNames, faceAncestry }
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
  )
  const { edgeNames, edgeAncestry } = deriveEdgeNames(oc, scope, transformedShape, face.faceNames, face.faceAncestry)
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
  sourceShape: OccShape,
  sourceNames: NameMaps,
  featureId: string,
  index: number,
  builder: OccTransformBuilder,
): NameMaps {
  const face = remapFaceNamesForInstance(
    oc,
    scope,
    instanceShape,
    sourceShape,
    sourceNames.faceNames,
    sourceNames.faceAncestry,
    featureId,
    index,
    builder,
  )
  const { edgeNames, edgeAncestry } = deriveEdgeNames(oc, scope, instanceShape, face.faceNames, face.faceAncestry)
  return { ...face, edgeNames, edgeAncestry }
}
