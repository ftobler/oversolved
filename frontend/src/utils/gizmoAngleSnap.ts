// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
//
// Angular snapping for the assembly triad's rotation rings. What snaps is the
// swing, the rotation delta accumulated since pointer-down, not the cursor's
// absolute bearing: the delta is what the user is authoring and what the part
// receives. The swing arrives already unwrapped (see `unwrapAngle` in
// gizmoMath.ts) and so grows past a full turn without bound, so nothing here may
// reduce it modulo a turn. A 725 degree swing belongs near 720, not near 0.

export const SNAP_STEP_DEG = 15
export const SNAP_TOLERANCE_DEG = 4

const DEG_TO_RAD = Math.PI / 180
const RAD_TO_DEG = 180 / Math.PI
const QUARTER_TURN = Math.PI / 2

export interface SwingSnap {
  /** The swing to apply, in radians: the snapped step, or the input untouched. */
  angle: number
  snapped: boolean
  /** Which multiple of SNAP_STEP_DEG was chosen. Meaningful only when snapped. */
  step: number
}

/**
 * The swing pulled onto the nearest multiple of SNAP_STEP_DEG when it is within
 * SNAP_TOLERANCE_DEG of one, otherwise handed back verbatim.
 *
 * The tolerance band is what makes this read as "it clicks when you drag across
 * the line" rather than a hard quantise; motion between bands stays free, and
 * the returned angle is then the caller's own value so free motion picks up no
 * rounding on the way through.
 */
export function snapSwing(swingRad: number): SwingSnap {
  const swingDeg = swingRad * RAD_TO_DEG
  const step = Math.round(swingDeg / SNAP_STEP_DEG)
  const targetDeg = step * SNAP_STEP_DEG
  if (Math.abs(swingDeg - targetDeg) <= SNAP_TOLERANCE_DEG) {
    return { angle: targetDeg * DEG_TO_RAD, snapped: true, step }
  }
  return { angle: swingRad, snapped: false, step }
}

/**
 * The grab bearing rounded to the nearest quarter turn.
 *
 * The user grabs the ring wherever they happen to click, which is arbitrary;
 * the dial reads its sweep from a quarter turn instead so the datum sits on a
 * clean bearing. A quarter turn is a whole number of steps, so the datum always
 * coincides with a tick.
 */
export function datumAngle(grabArmRad: number): number {
  return Math.round(grabArmRad / QUARTER_TURN) * QUARTER_TURN
}

/** The tick bearings the dial draws, one turn's worth starting at zero. */
export function snapTickAngles(): number[] {
  const count = 360 / SNAP_STEP_DEG
  const ticks: number[] = []
  for (let i = 0; i < count; i++) ticks.push(i * SNAP_STEP_DEG * DEG_TO_RAD)
  return ticks
}
