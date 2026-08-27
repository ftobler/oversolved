/**
 * Whether a click that resolved to nothing may clear the normal selection.
 *
 * The part editor has two clear paths and they must not drift: the Canvas
 * `onPointerMissed` when no sketch is active, and the DrawPlane backplane's
 * onClick when one is (the backplane is always hit, so R3F never reports a
 * miss inside a sketch). Both ask this.
 *
 * Four independent reasons a miss is not a deselect:
 *  - the id-buffer dispatcher already consumed the click, so clearing would
 *    wipe the element it just toggled in (and make multi-select impossible);
 *  - the resolve missed only because the id buffer was mid-rebuild, which is
 *    a transient transition, not empty space;
 *  - a rubber band is still open, so this click belongs to the sweep;
 *  - the gesture was not a stationary primary click. Camera work runs on the
 *    right button, and R3F counts `contextmenu` as a click event, so an orbit
 *    reaches the miss handler with zero travel; a left drag is a band or a
 *    part grab, not a deselect.
 */
export function missClearsNormalSelection(s: {
  clickConsumedByIdDispatch: boolean
  clickWasStaleResolve: boolean
  bandDragging: boolean
  stationaryPrimaryClick: boolean
}): boolean {
  if (s.clickConsumedByIdDispatch) return false
  if (s.clickWasStaleResolve) return false
  if (s.bandDragging) return false
  return s.stationaryPrimaryClick
}
