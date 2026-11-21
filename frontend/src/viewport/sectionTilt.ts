// The section plane's tilt, as pure angle math.
//
// Kept out of `sectionPlane.ts` for the same reason `sectionTypes.ts` is: the
// store clamps what it is handed, and a headless store must not pull the
// viewport's `three` import into its closure. `sectionPlane.ts` re-exports
// everything here, so consumers that already build clipping planes name one
// module.
//
// Pitch turns the source normal about the frame's `u`, then yaw turns it about
// the pitched `v`. That order is what lets each ring turn about the axis it is
// drawn around: pitch leaves `u` where it is, and pitch never moves the `v` that
// yaw turns about, so each ring is a constant circle while it is held and a
// drag can add its swing to the stored angle without re-basing. Two angles
// cannot accumulate a spin, so no roll can appear.
import { add, cross, dot, scale, type Vec3 } from '@/utils/vec3'
import type { SectionTilt } from './sectionTypes'

export type { SectionTilt } from './sectionTypes'
export { NO_TILT } from './sectionTypes'

/**
 * The steepest tilt the section accepts, measured from the source normal.
 *
 * At 90 degrees the plane would contain the source normal, so moving the pivot
 * along that normal would stop moving the cut (the offset conversion divides by
 * `n . n'`). A cut that steep is better made by picking another plane, so the
 * tilt refuses to go there and the dial readout holds at the limit.
 */
export const MAX_SECTION_TILT_DEG = 85

const DEG = Math.PI / 180
const COS_LIMIT = Math.cos(MAX_SECTION_TILT_DEG * DEG)

function unit(v: readonly number[]): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2])
  if (!(length > 1e-9)) return [0, 0, 1]
  return [v[0] / length, v[1] / length, v[2] / length]
}

/** Rodrigues rotation of `v` about `axis` by `angle`. */
function rotateAbout(axis: Vec3, v: Vec3, angle: number): Vec3 {
  const k = unit(axis)
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return add(
    add(scale(v, c), scale(cross(k, v), s)),
    scale(k, dot(k, v) * (1 - c)),
  )
}

/**
 * How far one angle may swing while its companion is at `otherCos`.
 *
 * The total tilt is within the limit exactly when `cos(pitch) cos(yaw) >=
 * cos(MAX)`, so the other angle's cosine caps this one. When the other angle
 * alone already exceeds the limit the cap becomes zero, which lets the caller's
 * second clamp pull the offending angle itself back.
 */
function angleLimit(otherCos: number): number {
  if (!Number.isFinite(otherCos)) return 0
  const ratio = COS_LIMIT / Math.max(COS_LIMIT, Math.abs(otherCos))
  return Math.acos(Math.min(1, ratio))
}

function clampTo(angle: number, limit: number): number {
  if (!Number.isFinite(angle)) return 0
  return Math.max(-limit, Math.min(limit, angle))
}

/**
 * Pull a requested tilt back into the cone where the section still moves along
 * its own normal. Each angle is clamped against the other, so a pitch drag past
 * the limit holds at a constant pitch (and a constant readout) while the yaw is
 * untouched, and vice versa. Idempotent, so the store and the geometry can both
 * apply it without compounding.
 */
export function clampSectionTilt(tilt: SectionTilt): SectionTilt {
  const pitch = clampTo(tilt.pitch, angleLimit(Math.cos(tilt.yaw)))
  const yaw = clampTo(tilt.yaw, angleLimit(Math.cos(tilt.pitch)))
  return { pitch, yaw }
}

/**
 * The tilt after one ring drag: the swing is added to the angle the drag
 * started from, then clamped. `swing` in the result is the part of the drag the
 * plane actually received, which is what the dial reads, so the readout holds
 * while the cursor keeps going past the limit.
 */
export function applySectionTiltSwing(
  start: SectionTilt,
  axis: keyof SectionTilt,
  swing: number,
): { tilt: SectionTilt; swing: number } {
  const requested = { ...start, [axis]: start[axis] + swing }
  const tilt = clampSectionTilt(requested)
  return { tilt, swing: tilt[axis] - start[axis] }
}

/**
 * The source pose a tilt is counted from. Structural rather than importing
 * `SectionFrame`, so a headless store can reach the clamp without the viewport's
 * three import graph (see sectionTypes.ts).
 */
export interface SectionOrientation {
  normal: Vec3
  u: Vec3
  v: Vec3
}

export interface TiltedSectionFrame {
  // The plane normal after the tilt.
  normal: Vec3
  // The axis the pitch ring turns about: the source `u`, unchanged by pitch.
  pitchAxis: Vec3
  // The axis the yaw ring turns about: the source `v` carried through the
  // pitch. Yaw turns about this very line, so it is also what the ring is drawn
  // around.
  yawAxis: Vec3
}

/** The plane's pose after `tilt`, plus the two ring axes it turns about. */
export function tiltedSectionFrame(
  frame: SectionOrientation,
  tilt: SectionTilt,
): TiltedSectionFrame {
  const u = unit(frame.u)
  const v = unit(frame.v)
  const n = unit(frame.normal)
  const clamped = clampSectionTilt(tilt)
  const pitchAxis = u
  const yawAxis = rotateAbout(u, v, clamped.pitch)
  // Rotating about the pitched v is the same as pitching the already-yawed
  // normal, which is why adding to `pitch` always turns about `pitchAxis`.
  const pitchedNormal = rotateAbout(u, n, clamped.pitch)
  return {
    normal: rotateAbout(yawAxis, pitchedNormal, clamped.yaw),
    pitchAxis,
    yawAxis,
  }
}

/**
 * The offset a drag of the arrow by `travel` along the tilted normal asks for.
 *
 * `offset` stays the pivot's distance along the SOURCE normal (the Offset box
 * keeps reading the same number), so travelling `t` along `n'` moves the pivot
 * by `t / (n . n')` along `n`. At the 85 degree limit that denominator is still
 * cos(85), never zero; a degenerate frame holds the offset instead of producing
 * Infinity.
 */
export function sectionOffsetFromTiltedDrag(
  startOffset: number,
  travel: number,
  frame: SectionOrientation,
  tilt: SectionTilt,
): number {
  const cos = dot(frame.normal, tiltedSectionFrame(frame, tilt).normal)
  if (!(Math.abs(cos) > 1e-9)) return startOffset
  return startOffset + travel / cos
}
