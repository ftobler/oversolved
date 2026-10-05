// The hover-resolve coalescer every viewport binds to, extracted from the part
// editor's id-buffer dispatcher so the assembly can share it.
//
// Reading the ID buffer means `readRenderTargetPixels`, which blocks the main
// thread until the GPU drains its queue; a high-rate pointer delivers several
// moves per frame, and resolving each one stacked those stalls. The scheduler
// caps hover resolves at ~two per animation frame: the first call in a frame
// resolves immediately, and every later call collapses into one trailing resolve
// at the latest query.
//
// It is also the cancellation owner: `clear()` bumps an epoch so an already
// launched readback lands as a no-op, and cancels the trailing frame so a clear
// cannot be undone by a queued resolve. Pure: no DOM, no store, no three.js. The
// frame functions are injected so tests need no requestAnimationFrame.

import { isDevBuild } from '@/kernel/isDevBuild'
import type { ResolvedHit } from './IdResolver'

export interface HoverQuery {
  cursor: { x: number; y: number }
  // The layers this hover may resolve. Kept on the query, so the trailing
  // resolve replays the latest set the caller built and a tool switch inside a
  // frame cannot replay a stale one.
  allowed: ReadonlySet<string>
}

export interface HoverSchedulerOptions {
  // Returns the resolver-ordered hits. Single-hit callers may return one.
  resolve: (q: HoverQuery) => Promise<readonly ResolvedHit[]> | readonly ResolvedHit[]
  onHits: (hits: readonly ResolvedHit[]) => void
  requestFrame?: (cb: () => void) => number
  cancelFrame?: (id: number) => void
  /**
   * Whether the first schedule in a frame resolves immediately (default) or is
   * deferred into the frame, so a frame costs at most one resolve. The part
   * editor's async readback wants the leading resolve; the assembly's blocking
   * sync readback wants the deferred mode, where it used to do one per frame.
   */
  leading?: boolean
}

export class HoverScheduler {
  private readonly resolveQuery: HoverSchedulerOptions['resolve']
  private readonly onHits: HoverSchedulerOptions['onHits']
  private readonly requestFrame: (cb: () => void) => number
  private readonly cancelFrame: (id: number) => void
  private readonly leading: boolean
  // The claimed frame, and the query waiting for it. `frame === 0` means none.
  private frame = 0
  private queued: HoverQuery | null = null
  // Bumped by clear/invalidate to drop a resolve already in flight.
  private epoch = 0

  constructor(options: HoverSchedulerOptions) {
    this.resolveQuery = options.resolve
    this.onHits = options.onHits
    this.requestFrame = options.requestFrame ?? (cb => requestAnimationFrame(cb))
    this.cancelFrame = options.cancelFrame ?? (id => cancelAnimationFrame(id))
    this.leading = options.leading ?? true
  }

  /**
   * A leading scheduler resolves the first call in a frame now and collapses
   * later calls into one trailing resolve at the latest query; a deferred one
   * queues even the first call and resolves once when the frame flushes, so a
   * blocking readback never runs more than once per frame. A query that allows
   * no layer tears the hover down instead, so a tool switch to a filtered set
   * cannot hold a stale highlight with no event left to remove it.
   */
  schedule(query: HoverQuery): void {
    if (query.allowed.size === 0) {
      this.clear()
      return
    }
    if (this.frame !== 0) {
      this.queued = query
      return
    }
    if (this.leading) this.run(query)
    else this.queued = query
    this.frame = this.requestFrame(() => {
      this.frame = 0
      const queued = this.queued
      this.queued = null
      if (!queued) return
      if (queued.allowed.size === 0) {
        this.clear()
        return
      }
      this.run(queued)
    })
  }

  // Drop any in-flight or queued resolve without tearing the hover down.
  invalidate(): void {
    this.epoch++
    if (this.frame !== 0) {
      this.cancelFrame(this.frame)
      this.frame = 0
    }
    this.queued = null
  }

  /**
   * Tear the hover down and make sure it cannot come back: invalidate, then
   * report an empty hit so the owner clears its highlight.
   */
  clear(): void {
    this.invalidate()
    this.onHits([])
  }

  private run(query: HoverQuery): void {
    const epoch = this.epoch
    let result: Promise<readonly ResolvedHit[]> | readonly ResolvedHit[]
    try {
      result = this.resolveQuery(query)
    } catch (err) {
      if (isDevBuild()) console.warn('hover resolve failed', err)
      return
    }
    // A synchronous resolver (the assembly's resolveAllSync) applies in the same
    // tick, so a hover stays as immediate as the old blocking rAF path. An async
    // one (the part editor's resolveAsync) applies on settle, guarded by the
    // epoch so a clear since it launched wins.
    const pending = result as Promise<readonly ResolvedHit[]>
    if (typeof pending.then !== 'function') {
      this.onHits(result as readonly ResolvedHit[])
      return
    }
    pending
      .then(hits => {
        // A clear/invalidate since this readback launched must win: applying a
        // hit now would resurrect a hover the clear was meant to end.
        if (epoch !== this.epoch) return
        this.onHits(hits)
      })
      // A swallowed apply error would kill the hover state machine with no
      // trace; the dev warn keeps the control flow identical while a prod build
      // stays quiet.
      .catch(err => { if (isDevBuild()) console.warn('hover apply failed', err) })
  }
}
