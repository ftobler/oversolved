// Plane math shared by the leaf feature solvers. Python distinguishes a
// Frame3D object from a plain plane dict via isinstance, but the two branches
// compute identical geometry. In TS both satisfy [[PlaneLike]], so the branch
// collapses to one path.

/** A plane as either a Frame3D or a plain `{origin, x_axis, y_axis, normal}` dict. */
export interface PlaneLike {
  origin: number[]
  x_axis: number[]
  y_axis: number[]
  normal: number[]
}

/** Transform 2D sketch coords to 3D world space (mirrors `_sketch_to_world_2d`). */
export function sketchToWorld2d(xy: number[], plane: PlaneLike): number[] {
  const [u, v] = xy
  return [
    plane.origin[0] + u * plane.x_axis[0] + v * plane.y_axis[0],
    plane.origin[1] + u * plane.x_axis[1] + v * plane.y_axis[1],
    plane.origin[2] + u * plane.x_axis[2] + v * plane.y_axis[2],
  ]
}

/**
 * True when two sketch planes are the same plane: same normal direction, same
 * offset along it, and same in-plane rotation, within the world vertex-merge
 * tolerance. Two sketches on one datum plane are a legitimate multi-sketch
 * profile; two on different planes are not -- every loop is lifted through the
 * FIRST plane's frame, so the second profile silently builds in the wrong place.
 */
export function samePlane(a: PlaneLike, b: PlaneLike, tol = 1e-5): boolean {
  const [an, bn] = [a.normal as number[], b.normal as number[]]
  const d = an[0] * bn[0] + an[1] * bn[1] + an[2] * bn[2]
  if (Math.abs(d - 1) > 1e-6) return false
  const ao = a.origin as number[]
  const bo = b.origin as number[]
  const off = (bo[0] - ao[0]) * an[0] + (bo[1] - ao[1]) * an[1] + (bo[2] - ao[2]) * an[2]
  if (Math.abs(off) > tol) return false
  // A second sketch's loop coords are relative to ITS frame; the feature lifts
  // them through the FIRST frame, so the in-plane rotation must match too.
  // y_axis follows from normal and x_axis, so comparing x_axis is enough.
  const ax = a.x_axis as number[]
  const bx = b.x_axis as number[]
  const r = ax[0] * bx[0] + ax[1] * bx[1] + ax[2] * bx[2]
  return Math.abs(r - 1) <= 1e-6
}
