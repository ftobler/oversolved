import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  markBandClickConsumed,
  takeBandClickConsumed,
  clearStaleBandClickConsumed,
  onFreshGesturePointerDown,
  useBandClickGuardCleanup,
} from '../bandClickGuard'

describe('bandClickGuard', () => {
  beforeEach(() => {
    takeBandClickConsumed()  // clear any flag leaked from a prior test
  })

  it('normal case: mark then immediate take returns true and clears the flag', () => {
    markBandClickConsumed()

    expect(takeBandClickConsumed()).toBe(true)
    expect(takeBandClickConsumed()).toBe(false)  // one-shot: already cleared
  })

  it('take returns false when nothing marked the click', () => {
    expect(takeBandClickConsumed()).toBe(false)
  })

  describe('stale-flag hygiene on the next gesture', () => {
    it('a fresh pointerdown clears a flag stranded by a teardown no click followed', () => {
      // A band torn down after its gesture's click already fired (the
      // stranded-release bail) can only be cleaned by the NEXT press.
      markBandClickConsumed()
      expect(takeBandClickConsumed()).toBe(true)

      markBandClickConsumed()
      onFreshGesturePointerDown()
      expect(takeBandClickConsumed()).toBe(false)
    })

    it('clearStaleBandClickConsumed clears synchronously', () => {
      markBandClickConsumed()
      clearStaleBandClickConsumed()
      expect(takeBandClickConsumed()).toBe(false)
    })

    it('the mounted cleanup listens on window pointerdown and stops on unmount', () => {
      const { unmount } = renderHook(() => useBandClickGuardCleanup())

      markBandClickConsumed()
      act(() => {
        window.dispatchEvent(new MouseEvent('pointerdown', { button: 0 }))
      })
      expect(takeBandClickConsumed()).toBe(false)

      // Unmount removes the listener: a later pointerdown no longer clears.
      unmount()
      markBandClickConsumed()
      act(() => {
        window.dispatchEvent(new MouseEvent('pointerdown', { button: 0 }))
      })
      expect(takeBandClickConsumed()).toBe(true)
    })
  })
})
