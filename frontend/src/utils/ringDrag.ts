// The rotation-ring drag law, shared by the assembly triad and the section
// plane's rings.
//
// Pure, framework-free and canvas-free: the caller supplies a world ray and the
// ring's pose, and gets the swing the pointer has made since the press. Both
// editors must turn their plane the same way, so there is one copy of the
// unwrap/snap/datum rules here rather than two that could drift apart.
//
// A drag is measured on the ring's own plane: the pointer ray is intersected
// with the plane through the ring's centre whose normal is the ring axis. The
// bearing of that hit is measured from `reference`, a companion axis in the
// ring's plane, so a drag is a change of bearing rather than an absolute angle.
import {
  intersectRayPlane, signedAngleAbout, sub, unwrapAngle,
  type Ray,
} from '@/utils/gizmoMath'
import { datumAngle, snapArmedAtRadius, snapSwing } from '@/utils/gizmoAngleSnap'
import type { Vec3 } from '@/utils/transform3d'

export interface RingDragState {
  // The ring's rotation axis, which is also the normal of the drag plane.
  axis: Vec3
  // The ring's centre: the pivot every bearing is measured about.
  origin: Vec3
  // Where the pointer first met the ring, relative to the centre. The swing is
  // measured from this arm, so it is relative to the press and never accumulates
  // drift across a long drag.
  startArm: Vec3
  // The raw unwrapped total since the press. The snap is applied on top of it,
  // never fed back into it: resolving the next reading from a tick instead of
  // from where the cursor is would let a snap capture the drag.
  swing: number
  // The bearing the dial reads from, fixed at the press.
  datum: number
}

export interface RingDragMove {
  // The swing to apply: the snapped angle, or the raw one when free.
  swing: number
  datum: number
  snapped: boolean
  // Whether snapping is in play at all: false once the cursor is pulled
  // outside the ring. Distinct from `snapped`, which is this frame's outcome.
  snapArmed: boolean
}

/**
 * Start a ring drag, or null when the pointer ray never meets the ring's plane
 * (a ring sighted exactly edge-on has no readable bearing).
 */
export function beginRingDrag(
  ray: Ray,
  origin: Vec3,
  axis: Vec3,
  reference: Vec3,
): RingDragState | null {
  const hit = intersectRayPlane(ray, origin, axis)
  if (!hit) return null
  const startArm = sub(hit, origin)
  return {
    axis,
    origin,
    startArm,
    swing: 0,
    datum: datumAngle(signedAngleAbout(axis, reference, startArm)),
  }
}

/**
 * Advance a drag by one pointer sample. Mutates `state.swing` (the running raw
 * total, which is what the next sample unwraps against) and returns the angle
 * to apply. Null when the ray no longer meets the ring plane, in which case the
 * gesture must simply leave the plane where it is.
 *
 * `gizmoWorldScale` is the world size of one gizmo unit right now. The arm
 * length decides whether snapping is armed: inside the drawn ring the drag
 * clicks onto the ticks, outside it the user has pulled away for fine control.
 * It is read per move so a camera dolly mid-drag cannot leave the gate and the
 * visible circle disagreeing; omitting it leaves snapping armed.
 */
export function moveRingDrag(
  state: RingDragState,
  ray: Ray,
  gizmoWorldScale?: number,
): RingDragMove | null {
  const hit = intersectRayPlane(ray, state.origin, state.axis)
  if (!hit) return null
  const arm = sub(hit, state.origin)
  state.swing = unwrapAngle(signedAngleAbout(state.axis, state.startArm, arm), state.swing)
  const armed = gizmoWorldScale === undefined
    || snapArmedAtRadius(Math.hypot(arm[0], arm[1], arm[2]), gizmoWorldScale)
  const snap = snapSwing(state.swing, armed)
  return { swing: snap.angle, datum: state.datum, snapped: snap.snapped, snapArmed: armed }
}
