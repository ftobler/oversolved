// The triad arrow's solid head, as pure math so it can be checked without a
// viewport.
//
// The head is ONE triangle, not a cone: at gizmo scale it is about 16 px long,
// where a cone's shading is too small to read and only costs vertices. What a
// flat triangle needs instead is to be turned toward the viewer, and the turn
// has to be CYLINDRICAL -- a spin about the arrow's own axis and nothing else.
// Full billboarding (a sprite always square to the camera) tilts the head off
// the shaft as soon as the user orbits, and a head that no longer points where
// its shaft points reads as broken geometry rather than as an arrow.
//
// The span is deliberately the one gizmoPickGeometry already hit-tests, namely
// [ARROW_LENGTH - HEAD_LENGTH/2, ARROW_LENGTH + HEAD_LENGTH/2], so drawn and
// grabbable stay one shape.

import { ARROW_LENGTH, HEAD_LENGTH, HEAD_RADIUS } from '@/utils/gizmoPickGeometry'
import type { Vec3 } from '@/utils/transform3d'

/** Where the head's flat base sits along the arrow, in gizmo-local units. */
export const ARROW_HEAD_BASE = ARROW_LENGTH - HEAD_LENGTH / 2

/** Where the head's point sits along the arrow, in gizmo-local units. */
export const ARROW_HEAD_TIP = ARROW_LENGTH + HEAD_LENGTH / 2

/**
 * The head's three corners in the arrow's local frame, where the arrow aims
 * along +Y. The triangle lies in the X/Y plane, so its normal starts at +Z and
 * `cylindricalBillboardAngle` is the amount to spin it about Y from there.
 * Wound base-left, tip, base-right; the material draws both sides, so the
 * winding only has to be consistent, not outward-facing.
 */
export function arrowHeadTriangle(): [Vec3, Vec3, Vec3] {
  return [
    [-HEAD_RADIUS, ARROW_HEAD_BASE, 0],
    [0, ARROW_HEAD_TIP, 0],
    [HEAD_RADIUS, ARROW_HEAD_BASE, 0],
  ]
}

/** The same triangle as a non-indexed position buffer for a BufferGeometry. */
export function arrowHeadPositions(): Float32Array {
  const [a, b, c] = arrowHeadTriangle()
  return new Float32Array([...a, ...b, ...c])
}

/**
 * How far to spin the head about its own axis (local +Y) so its face turns
 * toward the camera, given the camera's position expressed in the arrow's
 * local frame.
 *
 * A Y rotation by `t` carries the triangle's +Z normal to (sin t, 0, cos t),
 * so aligning that with the camera's off-axis bearing (x, z) is exactly
 * atan2(x, z). The camera's height along the arrow is ignored on purpose: that
 * is the component a full billboard would tilt into, and tilting is what
 * detaches the head from the shaft.
 *
 * Degenerate on purpose when the camera sights straight down the axis: atan2
 * returns 0 there, and the arrow is a dot on screen at that angle anyway.
 */
export function cylindricalBillboardAngle(cameraLocal: Vec3): number {
  return Math.atan2(cameraLocal[0], cameraLocal[2])
}

/**
 * A point spun about the arrow's own axis (local +Y), matching three.js's
 * `rotation.y` exactly so a caller can check the posed head without a scene
 * graph. Y is untouched by construction, which is the property that keeps the
 * head on its shaft.
 */
export function rotateAboutAxis(point: Vec3, angle: number): Vec3 {
  const s = Math.sin(angle)
  const c = Math.cos(angle)
  return [point[0] * c + point[2] * s, point[1], -point[0] * s + point[2] * c]
}
