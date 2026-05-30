/**
 * One-shot guard coordinating a single click between two listeners.
 *
 * A sketch drawing tool (notably `project`) commits on pointer-down and resets
 * the active tool synchronously (`clearTool`). The canvas-level click listener
 * fires AFTER pointer-up, by which point the tool reads as `null` and would
 * wrongly toggle normal selection on the entity the tool just consumed (e.g.
 * the body edge that was just projected).
 *
 * The drawing-tool pointer-down marks the gesture as its own; the click
 * listener reads-and-clears the flag and skips its own handling. pointer-down
 * always precedes the click, so the ordering is reliable. A drag that produces
 * no click leaves the flag set until the next click clears it -- harmless, and
 * the next drawing-tool pointer-down re-marks it anyway.
 */
let consumed = false

export function markDrawToolClickConsumed(): void {
  consumed = true
}

/** Read and clear the flag. Returns true if a drawing tool owned this click. */
export function takeDrawToolClickConsumed(): boolean {
  const v = consumed
  consumed = false
  return v
}
