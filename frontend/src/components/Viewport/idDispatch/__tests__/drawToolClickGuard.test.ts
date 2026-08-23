import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  markDrawToolClickConsumed,
  takeDrawToolClickConsumed,
  clearStaleDrawToolClickConsumed,
  onDrawToolGesturePointerUp,
} from '../drawToolClickGuard'

describe('drawToolClickGuard', () => {
  beforeEach(() => {
    takeDrawToolClickConsumed()  // clear any flag leaked from a prior test
  })

  it('normal case: mark then immediate take returns true and clears the flag', () => {
    markDrawToolClickConsumed()

    expect(takeDrawToolClickConsumed()).toBe(true)
    expect(takeDrawToolClickConsumed()).toBe(false)  // one-shot: already cleared
  })

  it('take returns false when nothing marked the click', () => {
    expect(takeDrawToolClickConsumed()).toBe(false)
  })

  describe('deferred cleanup on a gesture that ends without a click', () => {
    it('clears a flag left stale by a pointerup with no trailing click', () => {
      vi.useFakeTimers()
      try {
        // Drawing tool commits on pointer-down and marks the click...
        markDrawToolClickConsumed()
        // ...but the gesture ends off-canvas: no click listener ever reads the
        // flag, only the window pointerup fires.
        onDrawToolGesturePointerUp()

        // Still set immediately after pointerup -- the clear is deferred so a
        // same-target click (which fires synchronously right after pointerup)
        // gets first read.
        expect(takeDrawToolClickConsumed()).toBe(true)

        // Re-mark and let the deferred clear actually run this time, with no
        // take() in between (mirrors the off-canvas release: no click reads it).
        markDrawToolClickConsumed()
        onDrawToolGesturePointerUp()
        vi.runAllTimers()

        // A later, genuine, unrelated click must not be swallowed by the stale flag.
        expect(takeDrawToolClickConsumed()).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not clobber a normal click that already consumed the flag', () => {
      vi.useFakeTimers()
      try {
        markDrawToolClickConsumed()
        onDrawToolGesturePointerUp()  // scheduled, deferred

        // The canvas click listener runs synchronously right after pointerup,
        // before the deferred clear's timer fires.
        expect(takeDrawToolClickConsumed()).toBe(true)

        // The deferred clear now runs against an already-cleared flag: a no-op.
        vi.runAllTimers()
        expect(takeDrawToolClickConsumed()).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it('clearStaleDrawToolClickConsumed clears synchronously', () => {
      markDrawToolClickConsumed()
      clearStaleDrawToolClickConsumed()
      expect(takeDrawToolClickConsumed()).toBe(false)
    })
  })
})
