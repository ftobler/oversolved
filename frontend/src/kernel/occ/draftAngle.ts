// `applyDraftWithLineage`: the OCC adapter the draft leaf (features/draft.ts)
// calls to tilt picked faces about their intersection with a neutral plane
// (BRepOffsetAPI_DraftAngle).
//
// Call shape and history are pinned by draftAngleProbeReal.test.ts against the
// real OCCT 7.4.0p1 build:
//   - `new BRepOffsetAPI_DraftAngle_1()` + `Init(shape)` is the bound
//     constructor path; `Add(face, gp_Dir, angleRadians, gp_Pln, flag)` is the
//     5-argument form and `AddDone()` must precede `Build()`.
//   - A DRAFTED face is `Generated()` into its tilted image (its old self is
//     gone and reports neither Modified nor IsDeleted), a face whose geometry
//     the draft changed because it borders a drafted face is `Modified()`, and
//     an untouched face is `IsSame` in the output.
//   - A box's +x and -x faces, drafted +10 degrees with the neutral plane at
//     z=0 and the pull direction +z, give V = 823.673 on a 10-cube (one face
//     gives 911.837): a POSITIVE angle recedes along the pull direction.
//   - `Add` throws per face for a pick the draft cannot use, so a face the
//     kernel refuses is reported (failed), not fatal, as long as one pick
//     builds.
//
// Names are construction-based: a tilted face mints
// `<createdBy>|draft|<sourceFaceUuid>`, every other face carries its old UUID
// through the maker's Modified/IsSame history exactly as the shell's kept faces
// do. Geometry enters only the split ordering when one source face yields
// several images.

import type { DisposeScope } from './disposeScope'
import { drainList } from './disposeScope'
import type { OccModule, OccShape, OccSubShape } from './occTypes'
import type { Vec3 } from './primitives'
import { canonicalFaces, canonicalEdges } from './bodyNames'
import { emptyBrepDiff, type BrepDiff } from '../types3d'
import { isNullShape } from './primitives'
import { draftFacePath } from '../constructionName'
import { SubShapeDedup, SubShapeIndexMap, SubShapeMap } from './subshapeIdentity'
import { mintHistoryFaces, modifierShapeDiff } from './modifierNames'
import {
  builtFaceOf,
  inheritOldFaceNames,
  isValidShape,
  healShape,
  rebaseNames,
  rebaseDiff,
  type OldNames,
  type NewNames,
} from './edgeModifier'
import { nameNeighboursAndDeriveEdges } from './constructionLineage'

type Lineage = Record<string, string[]>

/** The neutral plane a draft rotates its faces about. */
export interface DraftNeutralPlane {
  origin: Vec3
  normal: Vec3
}

export interface DraftResult {
  shape: OccShape
  success: boolean
  reason: string | null
  names: NewNames | null
  diff: BrepDiff
  // The resolved input faces the maker accepted (their output image is the
  // tilted face) and refused, in input order.
  accepted: OccShape[]
  refused: OccShape[]
}

function fail(shape: OccShape, reason: string, accepted: OccShape[], refused: OccShape[]): DraftResult {
  return { shape, success: false, reason, names: null, diff: emptyBrepDiff(), accepted, refused }
}

/** The angle a draft measures in radians. */
function radians(angleDeg: number): number {
  return (angleDeg * Math.PI) / 180
}

/**
 * Draft `faces` on `shape` by `angleDeg` about `neutral`, pulling along `pull`.
 * Lineage is tracked only when `oldNames` is non-null (the caller passes it
 * when the body carries construction names). Failure returns the UNCHANGED
 * input shape with `success: false`; the caller must not release it (it is a
 * body store shape). A successful result's shape is DETACHED (the caller owns
 * it), matching `applyShellWithLineage`.
 */
export function applyDraftWithLineage(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  faces: OccShape[],
  angleDeg: number,
  pull: Vec3,
  neutral: DraftNeutralPlane,
  createdBy = '',
  oldNames: OldNames | null = null,
): DraftResult {
  if (isNullShape(shape)) return fail(shape, 'null_shape', [], [])
  if (faces.length === 0) return fail(shape, 'no_faces', [], [])

  const accepted: OccShape[] = []
  const refused: OccShape[] = []
  let maker
  try {
    maker = scope.track(new oc.BRepOffsetAPI_DraftAngle_1())
    const dir = scope.track(new oc.gp_Dir_4(pull[0], pull[1], pull[2]))
    const pnt = scope.track(new oc.gp_Pnt_3(neutral.origin[0], neutral.origin[1], neutral.origin[2]))
    const nrm = scope.track(new oc.gp_Dir_4(neutral.normal[0], neutral.normal[1], neutral.normal[2]))
    const pln = scope.track(new oc.gp_Pln_3(pnt, nrm))
    maker.Init(shape)
    for (const face of faces) {
      try {
        maker.Add(face as OccShape, dir, radians(angleDeg), pln, true)
      } catch {
        // The draft cannot use this face (its intersection with the neutral
        // plane is ill-defined, or it is parallel to the pull direction). The
        // leaf reports it as a failed pick; the other faces still build.
        refused.push(face)
        continue
      }
      accepted.push(face)
    }
    if (accepted.length === 0) return fail(shape, 'no_accepted_faces', accepted, refused)
    maker.AddDone()
    maker.Build()
    if (!maker.IsDone()) return fail(shape, 'build_not_done', accepted, refused)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return fail(shape, `build_failed: ${msg}`, accepted, refused)
  }

  const built = scope.track(maker.Shape())
  const oldFaces = canonicalFaces(oc, scope, shape) as OccShape[]
  const oldEdges = canonicalEdges(oc, scope, shape) as OccShape[]
  const newFaces = canonicalFaces(oc, scope, built) as OccShape[]
  const newEdges = canonicalEdges(oc, scope, built) as OccShape[]
  const diff = modifierShapeDiff(oldFaces, oldEdges, newFaces, newEdges)

  let names: NewNames | null = null
  if (oldNames !== null) {
    const faceNames: SubShapeMap<string> = new SubShapeMap()
    const faceAncestry: Lineage = {}
    const builtFace = builtFaceOf(newFaces)

    // Every non-drafted face keeps its old UUID through Modified/IsSame. The
    // drafted faces are excluded here: their old UUID dies with the tilt, and
    // the mint below names their image.
    const drafted = new SubShapeDedup()
    for (const f of accepted) drafted.add(f as OccSubShape)
    const keptFaces = oldFaces.filter((f) => !drafted.has(f as OccSubShape))
    const keptIdx = new SubShapeIndexMap()
    const keptModified = new Map<number, OccShape[]>()
    keptFaces.forEach((f, i) => {
      keptIdx.set(f as OccSubShape, i)
      const mods: OccShape[] = []
      try {
        mods.push(...drainList(scope, maker.Modified(f)).flatMap((g) => canonicalFaces(oc, scope, g) as OccShape[]))
      } catch {
        // A face the maker cannot narrate stays unnamed and the neighbour pass
        // recovers it, exactly as the shell's carry-forward does.
      }
      keptModified.set(i, mods)
    })
    inheritOldFaceNames(
      oc, scope, maker, oldNames, builtFace, faceNames, faceAncestry,
      keptFaces, keptIdx, keptModified,
    )
    mintHistoryFaces({
      oc,
      scope,
      maker,
      sourceFaces: accepted,
      uuidOf: (f) => oldNames.faceNames.get(f as OccSubShape),
      which: 'Generated',
      pathOf: (sourceUuid) => draftFacePath(createdBy, sourceUuid),
      ancestryOf: (sourceUuid) => oldNames.faceAncestry[sourceUuid] ?? [],
      builtFace,
      faceNames,
      faceAncestry,
      newShape: built,
    })

    const { edgeNames, edgeAncestry } = nameNeighboursAndDeriveEdges(oc, scope, built, faceNames, faceAncestry)
    names = { faceNames, edgeNames, faceAncestry, edgeAncestry }
  }

  if (!isValidShape(oc, scope, built)) {
    const heal = healShape(oc, scope, built)
    if (heal === null) {
      scope.release(built)
      return fail(shape, 'the operation produced invalid geometry; try a smaller angle', accepted, refused)
    }
    const rebased = names === null ? null : rebaseNames(names, heal.rebase)
    scope.release(built)
    return {
      shape: heal.shape, success: true, reason: null, names: rebased,
      diff: rebaseDiff(diff, heal.rebase), accepted, refused,
    }
  }

  return { shape: scope.detach(built), success: true, reason: null, names, diff, accepted, refused }
}
