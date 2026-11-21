// PURE LOGIC -- no React, no stores, no solver. The newest-value pump in front
// of a live feature-handle drag: a pointer move offers a value, but only one
// solve is ever in flight, so a slow rebuild cannot queue a backlog of stale
// values behind the pointer.

export interface LiveValuePump {
  /** Offer a fresh value. Sent at once when idle; otherwise it replaces the
   *  waiting value, so only the newest survives. */
  offer(value: number): void
  /** Send the last value once the in-flight one settles, and resolve after it
   *  has settled too. A value equal to the last sent one sends nothing. */
  flush(value: number): Promise<void>
  /** Drop everything waiting. An in-flight send still settles, but its
   *  continuation sends nothing more. */
  cancel(): void
}

/**
 * `send` resolves when the solve its value triggered has settled; a non-promise
 * return counts as settled at once. Values are already rounded by the caller,
 * so an equal offer is a pointer jittering inside one commit step and is
 * dropped instead of rebuilding.
 *
 * A gesture release does not go through `flush`: it cancels the pump and sends
 * its final value directly (see FeatureHandles), because the edit session can
 * close before an in-flight solve settles and the release must land inside it.
 * `flush` is the waiting contract for a caller that has no such boundary.
 */
export function createLiveValuePump(send: (value: number) => unknown): LiveValuePump {
  let inFlight: Promise<unknown> | null = null
  let lastSent: number | null = null
  let waiting: number | null = null
  let cancelled = false
  let flushTarget: number | null = null
  let flushResolve: (() => void) | null = null
  // The flush target was handed to send and its settle completes the flush.
  let flushSent = false

  function settleFlush(): void {
    const resolve = flushResolve
    flushResolve = null
    flushTarget = null
    flushSent = false
    resolve?.()
  }

  function start(value: number): void {
    lastSent = value
    let settled: Promise<unknown>
    try {
      // Promise.resolve covers both a synchronous send and a non-promise one,
      // and turns a throwing send into a settled pump rather than a dead one.
      settled = Promise.resolve(send(value))
    } catch {
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
    if (cancelled) {
      // A cancel during a flush must not leave its caller hanging.
      if (flushResolve !== null) settleFlush()
      return
    }
    if (inFlight !== null) return
    if (flushTarget !== null) {
      const target = flushTarget
      flushTarget = null
      if (target === lastSent) {
        settleFlush()
        return
      }
      flushSent = true
      start(target)
      return
    }
    if (waiting !== null) {
      const value = waiting
      waiting = null
      if (value !== lastSent) start(value)
      else pump()
      return
    }
    if (flushSent) settleFlush()
  }

  return {
    offer(value) {
      if (cancelled || value === lastSent) return
      waiting = value
      pump()
    },
    flush(value) {
      if (cancelled) return Promise.resolve()
      // The flush is the last word: a value still waiting is superseded.
      waiting = null
      return new Promise<void>(resolve => {
        if (inFlight === null && value === lastSent) {
          resolve()
          return
        }
        flushResolve = resolve
        flushTarget = value
        pump()
      })
    },
    cancel() {
      cancelled = true
      waiting = null
      flushTarget = null
      flushSent = false
      if (flushResolve !== null) settleFlush()
    },
  }
}
