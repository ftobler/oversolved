// Escape has more than one owner. Every modal built on the shared Dialog shell
// binds its own window keydown listener, and so does the global command
// dispatcher (dispatchKey -> cancel_draw). Both fire for the same keystroke,
// which is how dismissing a message box also destroyed the in-progress draw
// behind it.
//
// The fix is an explicit claim rather than listener ordering: a modal registers
// itself while it is on screen, and the global Escape command stands down for as
// long as anyone holds a claim. Ordering tricks (stopImmediatePropagation plus
// registration order) would depend on mount sequence, which no caller controls.

// A counter, not a boolean: two overlapping modals must not let the first one to
// close hand Escape back while the second is still up.
let claims = 0

/**
 * Claim Escape for a modal. Call from a mount effect and return the releaser as
 * the cleanup. The releaser is idempotent, so a double cleanup cannot drop the
 * count below what the remaining modals still hold.
 */
export function acquireModalEscape(): () => void {
  claims += 1
  let released = false
  return () => {
    if (released) return
    released = true
    claims -= 1
  }
}

// True while any modal is on screen and owns the Escape key.
export function modalOwnsEscape(): boolean {
  return claims > 0
}

/**
 * Drops every outstanding claim.
 * Intended for test teardown only, do not call in production code.
 */
export function resetModalEscape(): void {
  claims = 0
}
