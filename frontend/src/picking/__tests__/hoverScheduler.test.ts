// T4: the hover-resolve scheduler. Fake frame functions and a resolve spy, no
// DOM: the coalescing and cancellation are pure state.

import { describe, it, expect, vi } from 'vitest'
import { HoverScheduler, type HoverQuery } from '@/picking/HoverScheduler'
import type { ResolvedHit } from '@/picking'

/** A requestAnimationFrame double whose queued callbacks can be flushed by hand. */
function frameController() {
  let next = 1
  const callbacks = new Map<number, () => void>()
  return {
    requestFrame: (cb: () => void) => {
      const id = next++
      callbacks.set(id, cb)
      return id
    },
    cancelFrame: (id: number) => { callbacks.delete(id) },
    flush: () => {
      const cbs = [...callbacks.values()]
      callbacks.clear()
      for (const cb of cbs) cb()
    },
  }
}

const hit = (entityKey: string): ResolvedHit => ({ id: 1, layer: 'face', entityKey, distancePx: 0 })
const query = (x: number, y: number): HoverQuery => ({ cursor: { x, y }, allowed: new Set(['face']) })

describe('HoverScheduler', () => {
  it('resolves once immediately and once trailing at the latest cursor', () => {
    const frames = frameController()
    const calls: HoverQuery[] = []
    const scheduler = new HoverScheduler({
      resolve: (q) => { calls.push(q); return [hit('h')] },
      onHits: vi.fn(),
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    })

    scheduler.schedule(query(1, 1))
    expect(calls).toHaveLength(1)
    scheduler.schedule(query(2, 2))
    // Still one: the second move is queued for the frame, not resolved now.
    expect(calls).toHaveLength(1)

    frames.flush()
    expect(calls).toHaveLength(2)
    expect(calls[1].cursor).toEqual({ x: 2, y: 2 })
  })

  it('clear during an in-flight resolve drops the late result', async () => {
    const frames = frameController()
    const onHits = vi.fn()
    let settle: (hits: readonly ResolvedHit[]) => void = () => {}
    const scheduler = new HoverScheduler({
      resolve: () => new Promise<readonly ResolvedHit[]>(res => { settle = res }),
      onHits,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    })

    scheduler.schedule(query(1, 1))
    scheduler.clear()
    // The clear tears the hover down before the readback lands.
    expect(onHits).toHaveBeenLastCalledWith([])

    settle([hit('late')])
    await Promise.resolve()
    await Promise.resolve()
    // The late hit never applied: only the clear's empty report is on record.
    expect(onHits).toHaveBeenCalledTimes(1)
    expect(onHits).toHaveBeenCalledWith([])
  })

  it('clear cancels a queued trailing frame', () => {
    const frames = frameController()
    const resolve = vi.fn((): readonly ResolvedHit[] => [hit('h')])
    const scheduler = new HoverScheduler({
      resolve,
      onHits: vi.fn(),
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    })

    scheduler.schedule(query(1, 1))  // resolves now
    scheduler.schedule(query(2, 2))  // queued for the trailing frame
    scheduler.clear()

    frames.flush()
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('a deferred scheduler resolves only when the frame flushes, once at the latest cursor', () => {
    const frames = frameController()
    const calls: HoverQuery[] = []
    const scheduler = new HoverScheduler({
      leading: false,
      resolve: (q) => { calls.push(q); return [hit('h')] },
      onHits: vi.fn(),
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    })

    scheduler.schedule(query(1, 1))
    // Nothing resolves before the frame: a blocking readback runs at most once
    // per frame, and only at the newest cursor.
    expect(calls).toHaveLength(0)
    scheduler.schedule(query(2, 2))
    expect(calls).toHaveLength(0)

    frames.flush()
    expect(calls).toHaveLength(1)
    expect(calls[0].cursor).toEqual({ x: 2, y: 2 })
  })

  it('a query allowing no layers tears the hover down instead of resolving', () => {
    const frames = frameController()
    const onHits = vi.fn()
    const resolve = vi.fn((): readonly ResolvedHit[] => [hit('h')])
    const scheduler = new HoverScheduler({
      resolve, onHits, requestFrame: frames.requestFrame, cancelFrame: frames.cancelFrame,
    })

    scheduler.schedule({ cursor: { x: 1, y: 1 }, allowed: new Set() })
    expect(resolve).not.toHaveBeenCalled()
    expect(onHits).toHaveBeenLastCalledWith([])
  })

  // A resolver that throws (a GL readback on a lost context) must not escape
  // into the pointer handler that scheduled it, and must not wedge the
  // scheduler: the failure is reported and the next frame still resolves.
  it('reports a throwing resolver and stays usable for the next frame', () => {
    const frames = frameController()
    const onHits = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let fail = true
    const scheduler = new HoverScheduler({
      resolve: () => {
        if (fail) throw new Error('gl read failed')
        return [hit('h')]
      },
      onHits,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    })

    expect(() => scheduler.schedule(query(1, 1))).not.toThrow()
    expect(warn).toHaveBeenCalledWith('hover resolve failed', expect.any(Error))
    expect(onHits).not.toHaveBeenCalled()

    frames.flush()
    fail = false
    scheduler.schedule(query(2, 2))
    expect(onHits).toHaveBeenCalledWith([hit('h')])
    warn.mockRestore()
  })

  // The synchronous apply is wrapped like the async one: a consumer that throws
  // while applying a sync resolve must not escape into the pointer handler that
  // scheduled it, and must be reported the same way.
  it('swallows a throwing onHits on the synchronous path and warns', () => {
    const frames = frameController()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onHits = vi.fn(() => { throw new Error('consumer blew up') })
    const scheduler = new HoverScheduler({
      resolve: () => [hit('h')],
      onHits,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    })

    expect(() => scheduler.schedule(query(1, 1))).not.toThrow()
    expect(onHits).toHaveBeenCalledWith([hit('h')])
    expect(warn).toHaveBeenCalledWith('hover apply failed', expect.any(Error))
    warn.mockRestore()
  })
})
