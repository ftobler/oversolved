import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useEffect, useState } from 'react'
import { render, screen, waitFor, act } from '@testing-library/react'

// Deterministic pin for the DocumentPage.routing remount flake. On the RPi
// worker a slow commit can cross React's ~5ms frame budget, deferring the
// passive-effect flush to a later macrotask, so a text waitFor resolves while an
// effect-fed mock has not yet recorded anything. That interleaving is invisible
// on a fast box, so this meta-test models the same observable ordering: the
// READY text commits on a real 10ms timer (so waitFor genuinely waits on a
// macrotask commit) while the effect-fed record fires only when a deferred the
// test controls is released.
//
// The pin is deterministic because the record is TEST-gated, not because Node
// fires timers in due-time order: until the test releases the gate the log
// cannot have fired however the event loop is starved, and after the release it
// lands on the next microtask. The frame-yield mechanism itself is not what we
// pin here; the gated ordering is the user-visible contract, which is what the
// routing tests depend on.

const log = vi.fn()

// Deferred gate for the effect-fed record, recreated on every mount so each
// test releases its own gate.
let releaseLog: () => void = () => {}

function EffectRaceComponent() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const readyAt = setTimeout(() => setReady(true), 10)
    new Promise<void>(resolve => { releaseLog = resolve }).then(() => log('recorded'))
    return () => clearTimeout(readyAt)
  }, [])
  return <div>{ready ? 'READY' : 'BOOT'}</div>
}

describe('waitFor does not flush passive effects', () => {
  beforeEach(() => {
    log.mockClear()
    releaseLog = () => {}
  })

  // The naive shape (the one that flaked): a text waitFor, then a synchronous
  // read of an effect-fed mock. waitFor resolves as soon as READY is in the DOM
  // (~10ms), and the gate is never released, so the effect log CANNOT have fired
  // regardless of how the event loop is starved; the sync read must fail. If it
  // ever stops failing, the effect is recording outside the gate and the
  // discriminator is broken.
  it('naive text-waitFor-then-sync-read fails', async () => {
    render(<EffectRaceComponent />)
    await waitFor(() => expect(screen.getByText('READY')).toBeInTheDocument())

    expect(() => expect(log).toHaveBeenCalledTimes(1)).toThrow()
    expect(log).not.toHaveBeenCalled()
  })

  // The corrected shape: assert the effect-fed mock inside waitFor. Releasing
  // the gate delivers the log on the next microtask, and the await act already
  // flushes it, so waitFor's first check (or its next poll) observes the record.
  // If the release path never delivered the record, this waitFor would time out,
  // so the corrected shape is verified rather than assumed.
  it('waitFor-inside on the effect-fed mock passes', async () => {
    render(<EffectRaceComponent />)
    await waitFor(() => expect(screen.getByText('READY')).toBeInTheDocument())
    await act(async () => { releaseLog() })
    await waitFor(() => expect(log).toHaveBeenCalledTimes(1))
    expect(screen.getByText('READY')).toBeInTheDocument()
  })
})
