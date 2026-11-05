// Body extents along a sweep direction, shared by the through-all cutters.
// The hole leaf sizes a through bore from them and the extrude leaf sizes a
// through-all cut, so the measurement lives here rather than in either leaf.
//
// Vertices alone understate curved bodies (a cylinder's only vertices sit on its
// seam), so `bodyFrame` samples the edges and the frame is projected onto the
// sweep direction. A lateral AABB test is deliberately absent: a body farther
// along the same axis inflates the tool, which is harmless for a cut, while a
// lateral filter could silently under-size it.

import type { DisposeScope } from '../../occ/disposeScope'
import type { OccModule, OccShape } from '../../occ/occTypes'
import type { Vec3 } from '../../occ/primitives'
import { bodyFrame } from '../../occ/tessellation'

// Re-exported so both cutters take the whole AABB vocabulary from one module.
export { bodyFrame }

/** The AABB's half-extent projected onto `axis`: how far the body reaches
 *  either side of its centre along that direction. */
export function projectedRadius(frame: { half: Vec3 }, axis: Vec3): number {
  return Math.abs(axis[0]) * frame.half[0] + Math.abs(axis[1]) * frame.half[1] + Math.abs(axis[2]) * frame.half[2]
}

/** Extent of one body along the axis, from its edge-sampled AABB: the length a
 *  through-all cutter must clear. The AABB is projected onto the axis
 *  (2*sum(|axis_i|*half_i)) instead of taking the max world-axis half-extent: an
 *  oblique axis can cross a cube along its space diagonal, where the max-axis
 *  span underestimates the body by up to sqrt(3), leaving the far corner uncut
 *  while intersects() still reports a hit. */
export function bodySpanAlong(oc: OccModule, scope: DisposeScope, shape: OccShape, axis: Vec3): {
  span: number
  frame: { center: Vec3; half: Vec3 }
} {
  const frame = bodyFrame(oc, scope, shape)
  return { span: projectedRadius(frame, axis) * 2.0, frame }
}
