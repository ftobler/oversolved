// Authoring-time pose capture (WYSIWYG for the mates). When both of a mate's
// references are picked, the editor freezes the on-screen pose into the mate's
// authored params: `flip` from which way the two anchor axes currently point,
// `angle` (fixed/sliding) from the current roll between the anchors' canonical
// frames, and, for a fixed weld, `offset` from the current translation between
// the anchors carried into A's own frame. The solver then holds exactly the
// pose the user saw at the pick -- but as document data, not as solver seed
// state. Deriving these inside the solve from the seed pose instead is the bug
// family this replaces: solved-pose rounding baked into the doc became the new
// target (rotational drift), an authored angle re-applied per reseed (ratchet),
// and the weld side flipped with the seed (see mate_residuals.rs header).

import type { MateFeatureDef, MateOffsetVec, MateRef, Transform3D } from '@/types/cad'
import { dot } from '@/utils/gizmoMath'
import { lookupAnchor, type AnchorDescriptorTable, type AnchorTable } from '@/utils/anchorGizmos'
import type { MateParamPatch } from '@/utils/assemblyMutations'
import { ASSEMBLY_HANDLE } from '@/utils/assemblyBuiltins'
import { isMateRefEmpty, mateCapturesAngle, mateParams, normalizeMateAngleDeg } from '@/utils/mateKinds'
import { rollAboutAxisDeg } from '@/utils/mateOrientation'
import { IDENTITY_TRANSFORM, rotateVector, transformQuat, type Quat } from '@/utils/transform3d'

/** Round to make the captured value read like a number a user typed. 3
 *  decimals is ~0.06 arc-seconds of roll: far below solver tolerance, far
 *  above f32 wire noise. */
function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}

/** The document's stored coordinate precision (1e-6, the same quantum the
 *  mutation helpers round a persisted coordinate to), so a captured offset
 *  reads like an authored coordinate. Also folds -0 to plain 0. */
function round6(v: number): number {
  const r = Math.round(v * 1e6) / 1e6
  return r === 0 ? 0 : r
}

/**
 * A fixed mate's captured translation: the world delta between the two posed
 * anchors carried into A's own frame, `R_a^T (p_b - p_a)`, which is the frame
 * the solver reads `Mate::offset` in and the frame the offset rotates with A.
 * Storing the bare world delta would only be right while A's orientation is
 * identity, which is exactly the hand arithmetic this removes.
 *
 * A zero delta is the default (`offset` absent) and captures nothing, like a
 * default flip or angle, so the YAML stays clean. A non-zero delta is rounded
 * to the document's 1e-6 coordinate quantum.
 */
function fixedCapturedOffset(
  poseA: { point: readonly number[] },
  poseB: { point: readonly number[] },
  poseOfA: Transform3D,
): MateOffsetVec | undefined {
  const [qx, qy, qz, qw] = transformQuat(poseOfA)
  const inverse: Quat = [-qx, -qy, -qz, qw]
  const delta = rotateVector(inverse, [
    poseB.point[0] - poseA.point[0],
    poseB.point[1] - poseA.point[1],
    poseB.point[2] - poseA.point[2],
  ])
  const offset = { x: round6(delta[0]), y: round6(delta[1]), z: round6(delta[2]) }
  return offset.x === 0 && offset.y === 0 && offset.z === 0 ? undefined : offset
}

/**
 * The `flip`/`angle` patch the current pose implies for a mate, or null when
 * there is nothing to capture: a kind with no authored orientation, an
 * unfinished pick, or anchors the table cannot resolve (a stale ref with no
 * descriptor renders red instead of capturing a frame that no longer exists).
 * `descriptors` re-finds a ref whose persisted id moved, so re-aiming one field
 * still measures against the pose the other field names.
 *
 * For a fixed mate the patch also carries the pose's translation as `offset`
 * when `partPoses` names A's pose: a weld freezes the whole relative pose, and
 * the offset is carried into A's own frame (see `fixedCapturedOffset`). The
 * assembly frame is stationary, so its pose is the identity.
 *
 * A captured value equal to its default (`flip: false`, `angle: 0`, a zero
 * offset) comes back `undefined` so updateMate deletes the key: the YAML stays
 * clean and an untouched mate carries no params it does not need.
 */
export function captureMateOrientationPatch(
  mate: Pick<MateFeatureDef, 'kind'>,
  refA: MateRef | undefined,
  refB: MateRef | undefined,
  anchors: Readonly<AnchorTable>,
  descriptors?: Readonly<AnchorDescriptorTable>,
  partPoses?: Readonly<Record<string, Transform3D>>,
): MateParamPatch | null {
  const params = mateParams(mate.kind)
  if (!params.includes('flip')) return null
  if (isMateRefEmpty(refA) || isMateRefEmpty(refB)) return null
  const poseA = lookupAnchor(anchors, refA!, descriptors)
  const poseB = lookupAnchor(anchors, refB!, descriptors)
  if (!poseA || !poseB) return null

  const patch: MateParamPatch = {
    flip: dot(poseA.axis, poseB.axis) < 0 ? true : undefined,
  }

  // Roll capture needs the posed canonical frames; an anchor without one (a
  // static producer predating x_axis) resets the angle rather than measuring
  // against a wrong frame or keeping a value captured off different anchors --
  // the mate then holds the canonical zero roll.
  // A rotating mate's angle is an explicit lock, so a re-pick leaves it alone.
  if (mateCapturesAngle(mate.kind)) {
    const measurable = poseA.x_axis && poseB.x_axis
    // Normalised into the editor's [0, 360) authoring form, so a captured roll
    // reads the same as one typed or clicked into the box: rollAboutAxisDeg
    // returns atan2's (-180, 180], and a -10 degree pose would otherwise show
    // as -10 in a box that can produce no negative value itself. Rounding comes
    // FIRST -- normalising a hair below zero lands just under 360, and rounding
    // that afterwards would author a 360 the range does not contain.
    const raw = measurable ? round3(rollAboutAxisDeg(poseA.x_axis!, poseB.x_axis!, poseA.axis)) : 0
    const angle = normalizeMateAngleDeg(raw)
    patch.angle = angle === 0 ? undefined : angle
  }

  // Only a fixed mate reads its offset as a pose; for every other offset-reading
  // kind an offset means a separation, not a translation to freeze, so a
  // capture must leave it alone.
  if (mate.kind === 'fixed') {
    const poseOfA = refA!.part === ASSEMBLY_HANDLE ? IDENTITY_TRANSFORM : partPoses?.[refA!.part]
    if (poseOfA) patch.offset = fixedCapturedOffset(poseA, poseB, poseOfA)
  }

  return patch
}
