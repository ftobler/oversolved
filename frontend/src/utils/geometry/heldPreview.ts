// The post-drag hold: what a sketch renders between pointer-up and the fresh
// solve landing. Pure state, no React, so the rule can be unit tested without
// mounting a viewport.
//
// On pointer-up the committed mutation re-solves asynchronously. Until the fresh
// `solved` sketch arrives the viewport keeps showing the last drag preview, so
// the geometry does not snap back to its pre-drag position for the solver
// round-trip. A new `solved` identity supersedes the hold.
//
// The hold is only truthful when the gesture actually committed a mutation: only
// then is a fresh solve on its way. A gesture that emitted nothing (a locked
// fully constrained circle, a radius drag with no solved radius) has no solve to
// release the hold, so it must fall back to `solved` instead of freezing the
// preview and pinning the drag-staleness gate forever.

export interface HeldPreviewState<T> {
  // The solved sketch the tracker last saw.
  solved: T
  // The drag preview the tracker last saw; null when no drag is live.
  preview: T | null
  // The preview frozen at drag end, shown until a fresh solve lands.
  held: T | null
}

/** The tracker's next state. Returns the same object when neither input
 *  identity changed, so a render can skip the state write entirely.
 *
 *  `committed` is whether the gesture that just ended dispatched a mutation. It
 *  is only consulted at the drag-end transition; the early return means a
 *  committed flag flipping while nothing else changes cannot churn the state. */
export function nextHeldPreview<T>(
  state: HeldPreviewState<T>,
  solved: T,
  preview: T | null,
  committed: boolean,
): HeldPreviewState<T> {
  if (state.solved === solved && state.preview === preview) return state
  const held = state.solved !== solved
    // A fresh solve replaces the hold: the preview it was standing in for is
    // now genuinely stale.
    ? null
    : state.preview !== null && preview === null
      // The drag just ended. Freeze its last preview only when a mutation went
      // out; a no-commit gesture clears the hold and shows `solved`, because
      // nothing moved and no solve is coming to release a frozen preview.
      ? (committed ? state.preview : null)
      : state.held
  return { solved, preview, held }
}

/** What the sketch renders: the live preview while dragging (falling back to
 *  the hold when the preview has not produced a frame yet), then the hold, then
 *  the solve. */
export function sketchToDisplay<T>(
  solved: T,
  preview: T | null,
  held: T | null,
  dragging: boolean,
): T {
  return dragging ? preview ?? held ?? solved : held ?? solved
}
