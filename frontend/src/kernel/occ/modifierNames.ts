// The name-transfer machinery shared by whole-body modifiers that narrate
// their history through [[OccModifierHistory]]: the shell's thick solid and the
// draft's angle maker. Both need the same two steps --
//
//   1. every output face classified against the input's faces and edges into a
//      [[BrepDiff]] (inherited / new / modified / deleted), and
//   2. a role face minted from each source face's `Generated`/`Modified` images
//      (a shell's offset wall and rim, a draft's tilted face), one image keeping
//      the base path and several becoming ordered split children.
//
// They are one implementation here rather than one per maker, mirroring how
// [[inheritOldFaceNames]] is shared for the carry-forward pass.

import type { DisposeScope } from './disposeScope'
import { drainList } from './disposeScope'
import type { OccModule, OccModifierHistory, OccShape, OccSubShape } from './occTypes'
import { SubShapeDedup, faceCentroid } from './primitives'
import { emptyBrepDiff, type BrepDiff } from '../types3d'
import { canonicalFaces } from './bodyNames'
import { SubShapeMap } from './subshapeIdentity'
import { mintFaceUuid, splitFacePath, orderSplitChildren, type SplitChild } from '../constructionName'
import { shapeNormalFrame, normalizedWorldKey, type NormalFrame } from './constructionLineage'

type Lineage = Record<string, string[]>

/**
 * Classify a modifier output against its input (mirrors `edgeModifierDiff` and
 * the shell's former `shellDiff`): output faces/edges that are `IsSame` as an
 * input's are inherited, the rest are new; a face in `removedFaces` was deleted,
 * and an input face that no output holds (and was not removed) was modified.
 */
export function modifierShapeDiff(
  oldFaces: OccShape[],
  oldEdges: OccShape[],
  newFaces: OccShape[],
  newEdges: OccShape[],
  removedFaces: OccShape[] = [],
): BrepDiff {
  const diff = emptyBrepDiff()
  const facePool = new SubShapeDedup()
  for (const f of oldFaces) facePool.add(f as OccSubShape)
  for (const f of newFaces) (facePool.has(f as OccSubShape) ? diff.inherited_faces : diff.new_faces).push(f)

  const edgePool = new SubShapeDedup()
  for (const e of oldEdges) edgePool.add(e as OccSubShape)
  for (const e of newEdges) (edgePool.has(e as OccSubShape) ? diff.inherited_edges : diff.new_edges).push(e)

  const removed = new SubShapeDedup()
  for (const f of removedFaces) removed.add(f as OccSubShape)
  for (const f of oldFaces) {
    if (removed.has(f as OccSubShape)) diff.deleted_input_faces.push(f)
    else if (!facePool.has(f as OccSubShape)) diff.modified_input_faces.push(f)
  }
  diff.deleted_input_edges = oldEdges.filter((e) => !edgePool.has(e as OccSubShape))
  return diff
}

export interface MintHistoryFacesInput {
  oc: OccModule
  scope: DisposeScope
  maker: OccModifierHistory
  // The faces whose images are minted (a shell's kept or removed faces, a
  // draft's accepted picks).
  sourceFaces: OccShape[]
  // The old construction UUID of a source face, or undefined when it had none
  // (then nothing is minted for it).
  uuidOf: (f: OccShape) => string | undefined
  // The history call the images come from: `Generated` for a shell's offset
  // wall and a draft's tilted face, `Modified` for a shell's rim.
  which: 'Generated' | 'Modified'
  // The base construction path for `sourceUuid`, minted once per source (a split
  // child appends `|split|<i>`).
  pathOf: (sourceUuid: string) => string
  // The ancestry tokens a minted UUID carries, from its source face's UUID.
  ancestryOf: (sourceUuid: string) => string[]
  // Maps any image to the built solid's own face.
  builtFace: (f: OccShape) => OccSubShape
  faceNames: SubShapeMap<string>
  faceAncestry: Lineage
  // The built solid, for the split-ordering frame.
  newShape: OccShape
}

/**
 * Mint a construction UUID for every image the maker narrates for
 * `sourceFaces`, through `pathOf`. Existing names are never overwritten, so a
 * name inherited by the carry-forward pass wins and the first caller to reach a
 * shared image keeps it. One image keeps the base path; several become ordered
 * split children (`orderSplitChildren`, so two rebuilds of the same split mint
 * the same indices).
 */
export function mintHistoryFaces(input: MintHistoryFacesInput): void {
  const { oc, scope, maker, sourceFaces, uuidOf, which, pathOf, ancestryOf, builtFace, faceNames, faceAncestry, newShape } = input
  let frame: NormalFrame | null = null
  for (const src of sourceFaces) {
    const srcUuid = uuidOf(src)
    if (!srcUuid) continue
    let images: OccShape[]
    try {
      images = drainList(scope, maker[which](src)).flatMap((g) => canonicalFaces(oc, scope, g) as OccShape[])
    } catch {
      continue
    }
    if (images.length === 0) continue
    const ancestry = ancestryOf(srcUuid)
    const base = mintFaceUuid(pathOf(srcUuid))
    const assign = (face: OccShape, uuid: string): void => {
      const key = builtFace(face)
      if (faceNames.has(key)) return
      faceNames.set(key, uuid)
      faceAncestry[uuid] = [...ancestry]
    }
    if (images.length === 1) {
      assign(images[0], base)
    } else {
      frame ??= shapeNormalFrame(oc, scope, newShape)
      const f0 = frame
      const ordered = orderSplitChildren(
        images.map<SplitChild<OccShape>>((f) => ({
          item: f,
          key: normalizedWorldKey(f0, faceCentroid(oc, scope, f)),
        })),
      )
      if (ordered !== null) ordered.forEach((f, i) => assign(f, mintFaceUuid(splitFacePath(base, i))))
    }
  }
}
