// PURE LOGIC -- no three.js, no GL.

/**
 * When two marks are at "the same place", and how the index finds them.
 *
 * The positions that have to bucket together are not copies of one another: a
 * dock contact is re-derived from the solved params (`projectOnLine` in
 * `dockHosts`), a projected point is re-derived from the plane frame, and the
 * document origin is a literal 0 that a solved point pinned to it only reaches
 * to within its residual. At a TANGENCY the disagreement is amplified rather
 * than damped -- the offset along the line goes as `sqrt(2r * dr)`, so a 1e-14
 * gap between two constraint residuals comes out at ~4e-7 -- which lands right
 * around one float32 step at sketch scale. So an exact key, float32 or not,
 * splits exactly the pairs it exists to join, and it does so for the shapes a
 * sketch is full of.
 *
 * Hence a tolerance, and it has to be RELATIVE: float32's own step is 1.2e-7 of
 * the magnitude, so any fixed absolute figure is either coarser than the step at
 * small coordinates or finer than it at large ones, and a mark at x = 50 would
 * be back to needing bit equality. `MARK_REL_TOL` is 2^-20, eight float32 steps
 * -- close enough to the storage precision to keep the old rule's spirit ("these
 * cannot be told apart by anything downstream"), and about a thousandth of a
 * pixel at any zoom that shows the coordinate, so it can never join two marks a
 * user could see apart.
 *
 * `MARK_ABS_TOL` is the floor that relative alone cannot supply: near zero the
 * relative window shrinks to nothing, and a point constrained to the origin
 * solves to 1e-11 rather than to 0. Below it, magnitude stops meaning anything
 * and every coordinate is the same coordinate.
 *
 * This stays a confined, render-local answer to which marks share a pixel. It is
 * NOT geometric identity: ids are still allocated by query, two entities
 * bucketed together keep their own id, query and pick key, and they separate the
 * moment their positions differ by more than the window above.
 */
export const MARK_REL_TOL = 2 ** -20
export const MARK_ABS_TOL = 1e-7

/** Do two coordinates on one axis fall inside the coincidence window? Symmetric
 *  in its arguments, so "a recovers b" and "b recovers a" are the same question
 *  -- which is what makes the answer independent of who won the pixel. */
export function axisCoincides(a: number, b: number): boolean {
  const d = Math.abs(a - b)
  if (!(d > 0)) return true  // equal, or a NaN pair we are not going to separate
  return d <= Math.max(MARK_ABS_TOL, MARK_REL_TOL * Math.max(Math.abs(a), Math.abs(b)))
}

export function marksCoincide(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
): boolean {
  return axisCoincides(ax, bx) && axisCoincides(ay, by) && axisCoincides(az, bz)
}

const F32 = new Float32Array(1)
const U32 = new Uint32Array(F32.buffer)

/**
 * A float32's bits reordered so that integer order matches numeric order across
 * the whole range, negatives included. Adjacent floats differ by 1, which is
 * what lets a cell index be a plain shift and still scale with magnitude the
 * way the tolerance does.
 */
function monotoneBits(v: number): number {
  F32[0] = v
  const bits = U32[0]
  return (bits & 0x80000000) !== 0 ? (~bits >>> 0) : ((bits | 0x80000000) >>> 0)
}

// A cell spans 2^4 = 16 float32 steps, twice `MARK_REL_TOL`. Two positions
// inside the window are therefore never more than one cell apart, which is why
// probing the immediate neighbours is enough and probing further is not needed.
const CELL_BITS = 4
const MONO_POS_FLOOR = monotoneBits(MARK_ABS_TOL)
const MONO_NEG_FLOOR = monotoneBits(-MARK_ABS_TOL)

/**
 * The cell index of one coordinate: monotone, and contiguous across the floor.
 * Everything within `MARK_ABS_TOL` of zero collapses into cell 0, and the cells
 * on either side of it are numbered +-1 outward, so a neighbour probe crosses
 * the floor like any other cell boundary instead of falling off it.
 */
export function axisCell(v: number): number {
  if (v > MARK_ABS_TOL)  return  (((monotoneBits(v) - MONO_POS_FLOOR) >>> CELL_BITS) + 1)
  if (v < -MARK_ABS_TOL) return -(((MONO_NEG_FLOOR - monotoneBits(v)) >>> CELL_BITS) + 1)
  return 0
}

export type MarkCell = readonly [number, number, number]

export function markCell(x: number, y: number, z: number): MarkCell {
  return [axisCell(x), axisCell(y), axisCell(z)]
}

export function markCellKey(cx: number, cy: number, cz: number): string {
  return `${cx},${cy},${cz}`
}

/** The 27 offsets of a cell and its immediate neighbours, own cell first so a
 *  scan that stops early stops on the closest bucket. */
export const MARK_CELL_NEIGHBOURS: ReadonlyArray<MarkCell> = (() => {
  const out: MarkCell[] = [[0, 0, 0]]
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx !== 0 || dy !== 0 || dz !== 0) out.push([dx, dy, dz])
      }
    }
  }
  return out
})()
