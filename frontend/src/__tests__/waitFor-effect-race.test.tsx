import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useEffect, useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'

// Deterministic pin for the DocumentPage.routing remount flake
// (feature/documentpage-remount-flake.md). On the RPi worker a slow commit can
// cross React's ~5ms frame budget, deferring the passive-effect flush to a later
// macrotask, so a text waitFor resolves while an effect-fed mock has not yet
// recorded anything. That interleaving is invisible on a fast box, so this
// meta-test models the same observable ordering with plain timers instead: the
// READY text commits at ~10ms while the effect's log is due at ~100ms.
//
// The frame-yield mechanism itself is not what we pin here; the two-timer gap
// reproduces the user-visible contract, which is what the routing tests depend
// on and what can be asserted deterministically on any machine.

const log = vi.fn()

function EffectRaceComponent() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const readyAt = setTimeout(() => setReady(true), 10)
    const logAt = setTimeout(() => log('recorded'), 100)
    return () => {
      clearTimeout(readyAt)
      clearTimeout(logAt)
    }
  }, [])
  return <div>{ready ? 'READY' : 'BOOT'}</div>
}

describe('waitFor does not flush passive effects', () => {
  beforeEach(() => {
    log.mockClear()
  })

  // The naive shape (the one that flaked): a text waitFor, then a synchronous
  // read of an effect-fed mock. waitFor resolves as soon as READY is in the DOM
  // (~10ms), and the effect log cannot have fired yet (due at ~100ms), so the
  // sync read must fail. If it ever stops failing, the effect is recording
  // synchronously and the discriminator is broken.
  it('naive text-waitFor-then-sync-read fails', async () => {
    render(<EffectRaceComponent />)
    await waitFor(() => expect(screen.getByText('READY')).toBeInTheDocument())

    expect(() => expect(log).toHaveBeenCalledTimes(1)).toThrow()
    expect(log).not.toHaveBeenCalled()
  })

  // The corrected shape: assert the effect-fed mock inside waitFor. The log
  // timer fires at ~100ms, the next 50ms poll sees it, well inside the 1000ms
  // waitFor timeout.
  it('waitFor-inside on the effect-fed mock passes', async () => {
    render(<EffectRaceComponent />)
    await waitFor(() => expect(log).toHaveBeenCalledTimes(1))
    expect(screen.getByText('READY')).toBeInTheDocument()
  })
})
