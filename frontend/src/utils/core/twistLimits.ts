// The twist angle's ladder, shared by the drive boundary and the kernel builder.
// It lives here rather than in kernel/occ/twistPrism so `drive/mutationValues`
// can refuse an out-of-range angle without importing the OCC builder graph.

/** Degrees of twist one loft section carries. The sections interpolate a
 *  rotation, so this bounds the piecewise-linearity of the seam path and the
 *  section count at once; the spike (`twistPrismReal.test.ts`) measured the
 *  volume error at 1e-9 relative for the profiles it pins at this step. */
export const TWIST_STEP_DEG = 10

/** The work bound on an authored angle. A twist is not itself limited to one
 *  turn (a screw twists many), but a hand-typed million degrees must not ask the
 *  loft for an unbounded number of sections. */
export const MAX_TWIST_SECTIONS = 720

/** The largest angle the builder accepts, in degrees. */
export const MAX_TWIST_DEG = TWIST_STEP_DEG * MAX_TWIST_SECTIONS

/** How many loft segments an authored twist takes. At least two: a single
 *  section has no rotation to interpolate and would be the straight prism. */
export function twistSectionCount(twistDeg: number): number {
  return Math.max(2, Math.ceil(Math.abs(twistDeg) / TWIST_STEP_DEG))
}
