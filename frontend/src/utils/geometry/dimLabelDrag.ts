// Pure geometry leaves for a sketch viewport drag. Kept out of the components
// tree so the commit rule can be unit tested without mounting anything.

/** World-unit travel below which a dimension label drag is a click, not a
 *  move. The label sits on a shape whose smallest meaningful nudge is far above
 *  this, so a stationary release never writes a `set_constraint_pos` and with it
 *  a junk undo entry. */
export const DIM_LABEL_MIN_TRAVEL = 1e-4

/**
 * The anchor-relative offset a dimension label drag commits, or null when it
 * never left its anchor. The offset is what `set_constraint_pos` stores, not the
 * absolute position, so the label keeps following its constraint.
 */
export function dimLabelCommitOffset(
  currentWorld: readonly [number, number],
  anchorWorld: readonly [number, number],
): [number, number] | null {
  const offset: [number, number] = [
    currentWorld[0] - anchorWorld[0],
    currentWorld[1] - anchorWorld[1],
  ]
  return Math.hypot(offset[0], offset[1]) >= DIM_LABEL_MIN_TRAVEL ? offset : null
}
