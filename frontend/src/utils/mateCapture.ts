// Authoring-time orientation capture (WYSIWYG for the axis mates). When both
// of a mate's references are picked, the editor freezes the on-screen
// orientation into the mate's authored params: `flip` from which way the two
// anchor axes currently point, `angle` (fixed/sliding) from the current roll
// between the anchors' canonical frames. The solver then holds exactly the
// pose the user saw at the pick -- but as document data, not as solver seed
// state. Deriving these inside the solve from the seed pose instead is the bug
// family this replaces: solved-pose rounding baked into the doc became the new
// target (rotational drift), an authored angle re-applied per reseed (ratchet),
// and the weld side flipped with the seed (see mate_residuals.rs header).

import type { MateFeatureDef, MateRef } from '@/types/cad'
import { dot } from '@/utils/gizmoMath'
import { lookupAnchor, type AnchorTable } from '@/utils/anchorGizmos'
import type { MateParamPatch } from '@/utils/assemblyMutations'
import { isMateRefEmpty, mateParams } from '@/utils/mateKinds'
import { rollAboutAxisDeg } from '@/utils/mateOrientation'

/** Round to make the captured value read like a number a user typed. 3
 *  decimals is ~0.06 arc-seconds of roll: far below solver tolerance, far
 *  above f32 wire noise. */
function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}

/**
 * The `flip`/`angle` patch the current pose implies for a mate, or null when
 * there is nothing to capture: a kind with no authored orientation, an
 * unfinished pick, or anchors the table cannot resolve (a stale ref renders
 * red instead of capturing a frame that no longer exists).
 *
 * A captured value equal to its default (`flip: false`, `angle: 0`) comes back
 * `undefined` so updateMate deletes the key: the YAML stays clean and an
 * untouched mate carries no params it does not need.
 */
export function captureMateOrientationPatch(
  mate: Pick<MateFeatureDef, 'kind'>,
  refA: MateRef | undefined,
  refB: MateRef | undefined,
  anchors: Readonly<AnchorTable>,
): MateParamPatch | null {
  const params = mateParams(mate.kind)
  if (!params.includes('flip')) return null
  if (isMateRefEmpty(refA) || isMateRefEmpty(refB)) return null
  const poseA = lookupAnchor(anchors, refA!)
  const poseB = lookupAnchor(anchors, refB!)
  if (!poseA || !poseB) return null

  const patch: MateParamPatch = {
    flip: dot(poseA.axis, poseB.axis) < 0 ? true : undefined,
  }

  // Roll capture needs the posed canonical frames; an anchor without one (a
  // static producer predating x_axis) resets the angle rather than measuring
  // against a wrong frame or keeping a value captured off different anchors --
  // the mate then holds the canonical zero roll.
  if (params.includes('angle')) {
    const measurable = poseA.x_axis && poseB.x_axis
    const angle = measurable ? round3(rollAboutAxisDeg(poseA.x_axis!, poseB.x_axis!, poseA.axis)) : 0
    patch.angle = angle === 0 ? undefined : angle
  }

  return patch
}
