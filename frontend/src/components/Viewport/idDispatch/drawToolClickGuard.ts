import { useEffect } from 'react'

/**
 * One-shot guard coordinating a single click between two listeners.
 *
 * A sketch drawing tool commits on pointer-down and the tool may stay armed
 * afterwards (a sticky draw tool, or the line tool mid-polyline). The
 * canvas-level click listener fires AFTER pointer-up, and on a tool with no
 * `onClick` handler `dispatchSketchClick` falls through to
 * `toggleNormalSelection`, which would wrongly toggle normal selection on the
 * entity the tool just consumed (e.g. the body edge that was just projected).
 *
 * The drawing-tool pointer-down marks the gesture as its own; the click
 * listener reads-and-clears the flag and skips its own handling. pointer-down
 * always precedes the click, so the ordering is reliable.
 *
 * A gesture that ends without a click on the canvas (pointer released outside
 * the canvas, or the browser ends it with pointercancel / lostpointercapture
 * instead of a click-producing pointerup) used to leave the flag set
 * indefinitely, so the NEXT, unrelated click was wrongly swallowed by a stale
 * flag left over from a gesture that had nothing to do with it.
 * useDrawToolClickGuardCleanup (mounted once by Viewport) closes that gap: it
 * listens on window for pointerup / pointercancel / lostpointercapture and
 * schedules a deferred clear. The clear runs on a macrotask so it always
 * lands after any click the same gesture produces (click fires synchronously
 * right after pointerup on the same target), so on a normal click the
 * deferred clear is a no-op -- the click listener already read-and-cleared
 * the flag itself. Only a gesture that produced no click leaves the flag for
 * the deferred clear to actually reset.
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

/** The deferred core: clears whatever is left over once a gesture is done. */
export function clearStaleDrawToolClickConsumed(): void {
  consumed = false
}

/**
 * Registered on window for pointerup / pointercancel / lostpointercapture.
 * Defers to a macrotask (see module comment) so a genuine trailing click
 * always gets first read of the flag.
 */
export function onDrawToolGesturePointerUp(): void {
  setTimeout(clearStaleDrawToolClickConsumed, 0)
}

export function useDrawToolClickGuardCleanup(): void {
  useEffect(() => {
    window.addEventListener('pointerup', onDrawToolGesturePointerUp)
    window.addEventListener('pointercancel', onDrawToolGesturePointerUp)
    window.addEventListener('lostpointercapture', onDrawToolGesturePointerUp)
    return () => {
      window.removeEventListener('pointerup', onDrawToolGesturePointerUp)
      window.removeEventListener('pointercancel', onDrawToolGesturePointerUp)
      window.removeEventListener('lostpointercapture', onDrawToolGesturePointerUp)
    }
  }, [])
}
