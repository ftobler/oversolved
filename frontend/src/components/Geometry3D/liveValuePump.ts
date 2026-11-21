// PURE LOGIC -- no React, no stores, no solver. The newest-value pump in front
// of a live feature-handle drag: a pointer move offers a value, but only one
// solve is ever in flight, so a slow rebuild cannot queue a backlog of stale
// values behind the pointer.

export interface LiveValuePump {
  /** Offer a fresh value. Sent at once when idle; otherwise it replaces the
   *  waiting value, so only the newest survives. Offering the value that is
   *  already in flight drops whatever was waiting: the pointer came back. */
  offer(value: number): void
  /** Drop everything waiting. An in-flight send still settles, but its
   *  continuation sends nothing more. */
  cancel(): void
}

/**
 * `send` resolves when the solve its value triggered has settled; a non-promise
 * return counts as settled at once. Values are already rounded by the caller,
 * so an equal offer is a pointer jittering inside one commit step and is
 * dropped instead of rebuilding. A rejected send is a failed solve the solver
 * already reports, so it only releases the next value; a synchronous throw is
 * a caller bug and is surfaced once.
 */
export function createLiveValuePump(send: (value: number) => unknown): LiveValuePump {
  let inFlight: Promise<unknown> | null = null
  let lastSent: number | null = null
  let waiting: number | null = null
  let cancelled = false
  let reportedThrow = false

  function start(value: number): void {
    lastSent = value
    let settled: Promise<unknown>
    try {
      // Promise.resolve covers both a synchronous send and a non-promise one.
      settled = Promise.resolve(send(value))
    } catch (error) {
      if (!reportedThrow) {
        reportedThrow = true
        console.error('[liveValuePump] send threw; the drag continues without it', error)
      }
      settled = Promise.resolve()
    }
    inFlight = settled
    const done = (): void => {
      if (inFlight !== settled) return
      inFlight = null
      pump()
    }
    settled.then(done, done)
  }

  function pump(): void {
    if (cancelled || inFlight !== null || waiting === null) return
    const value = waiting
    waiting = null
    // `offer` already drops a value equal to the last sent one; staying total
    // here keeps that invariant from sending a duplicate if it ever changes.
    if (value !== lastSent) start(value)
  }

  return {
    offer(value) {
      if (cancelled) return
      // The pointer returned to the value the in-flight solve is already
      // building: the waiting value is stale, and sending it after the flight
      // would rebuild the body at the old value while the arrow reads this one.
      if (value === lastSent) {
        waiting = null
        return
      }
      waiting = value
      pump()
    },
    cancel() {
      cancelled = true
      waiting = null
    },
  }
}
