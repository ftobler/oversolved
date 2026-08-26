import { useEffect } from 'react'

/**
 * One-shot guard coordinating a rubber-band release with the trailing native
 * click.
 *
 * A band sweep commits (or tears down) on pointer-up; the browser then fires
 * click after pointerup, and the id-buffer dispatcher would resolve the
 * RELEASE pixel: toggling whatever sub-shape sits under the sweep's end
 * cursor on top of the box the band just committed, or finalizing pending
 * dimension picks when the sweep ended over empty space. Every teardown of a
 * visibly-open band marks this flag (useRubberBandSelect's endDrag), and the
 * dispatcher reads-and-clears it before resolving, mirroring
 * drawToolClickGuard for drawing tools.
 *
 * The stale-flag strategy differs from drawToolClickGuard's deferred-macrotask
 * clear because a band can be torn down AFTER its own gesture's click already
 * fired: the stranded-release bail (a pointermove with no button held) runs
 * precisely when the physical release was never seen, so no trailing click is
 * coming. Deferring the clear behind a pointerup timer would strand the flag
 * into the NEXT gesture's click; clearing on window pointerdown cannot. Within
 * the owning gesture the raise happens on pointerup, strictly after that
 * gesture's own pointerdown cleared nothing but an already-stale flag, and the
 * trailing click lands before any new pointerdown can occur.
 */
let consumed = false

export function markBandClickConsumed(): void {
  consumed = true
}

/** Read and clear the flag. Returns true if an open rubber band owned this click. */
export function takeBandClickConsumed(): boolean {
  const v = consumed
  consumed = false
  return v
}

/** The synchronous core: drops whatever a stranded teardown left over. */
export function clearStaleBandClickConsumed(): void {
  consumed = false
}

/**
 * Registered on window for pointerdown. A fresh press always begins a new
 * gesture, so a flag still set from an earlier one can never belong to the
 * click that gesture produces.
 */
export function onFreshGesturePointerDown(): void {
  clearStaleBandClickConsumed()
}

export function useBandClickGuardCleanup(): void {
  useEffect(() => {
    window.addEventListener('pointerdown', onFreshGesturePointerDown)
    return () => window.removeEventListener('pointerdown', onFreshGesturePointerDown)
  }, [])
}
