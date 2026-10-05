/**
 * A DisposeScope that counts track()/release() traffic and the peak number of
 * simultaneously-live proxies. `peakLive` is max(tracked - released): the
 * number a per-build disposal suite asserts is positive and flat across
 * rebuilds, so a refactor that keeps proxies alive longer shows up as a larger
 * peak instead of silently passing. The flat-across-rebuilds idiom lives in
 * features/loweringDisposalReal.test.ts.
 */

import { DisposeScope, type Disposable } from './disposeScope'

export class CountingScope extends DisposeScope {
  trackCount = 0
  releaseCount = 0
  peakLive = 0
  private live = 0

  override track<T extends Disposable>(obj: T): T {
    this.trackCount++
    this.live++
    this.peakLive = Math.max(this.peakLive, this.live)
    return super.track(obj)
  }

  override release<T extends Disposable>(obj: T): T {
    const before = this.size()
    const result = super.release(obj)
    // Base release() drops EVERY tracking entry for `obj`, including none for a
    // foreign object, so live must fall by the number of entries actually
    // removed, not by one per call, or peakLive undercounts multiply-tracked
    // objects and goes negative for never-tracked ones.
    const dropped = before - this.size()
    this.releaseCount += dropped
    this.live -= dropped
    return result
  }
}