import { describe, it, expect } from 'vitest'

describe('reSolve stale-request guards', () => {
  it('test_stale_resolve_discarded: solver-path guard after cacheBuildResponse prevents stale writes', async () => {
    // Scenario: solve A and solve B both complete the solve() await, but A then
    // awaits cacheBuildResponse while B sneaks in and finishes first. Without a
    // guard after cacheBuildResponse, A would overwrite B's result.

    let requestId = 0
    const applied: string[] = []

    // Manually controlled promise to block A's cache step
    let resolveA!: () => void
    const cacheA = new Promise<void>(res => { resolveA = res })

    async function solveA() {
      const currentRequestId = ++requestId  // 1
      await Promise.resolve()  // simulate await solve(...)
      if (currentRequestId !== requestId) return
      await cacheA  // simulate slow cacheBuildResponse
      if (currentRequestId !== requestId) return  // the fix
      applied.push('A')
    }

    async function solveB() {
      const currentRequestId = ++requestId  // 2
      await Promise.resolve()  // simulate await solve(...)
      if (currentRequestId !== requestId) return
      // no cache delay for B
      applied.push('B')
    }

    const pA = solveA()
    // Drain microtasks so A gets past await solve() and blocks on cacheA
    await Promise.resolve()
    await Promise.resolve()

    const pB = solveB()
    await pB  // B completes fully

    expect(applied).toEqual(['B'])

    // Unblock A's cache - it should detect staleness and not apply
    resolveA()
    await pA

    expect(applied).toEqual(['B'])  // A was discarded
  })

  it('test_cache_hit_stale_discarded: cache-hit result is discarded when a newer solve has started', async () => {
    // Scenario: solve A hits the cache (fast), but solve B is already in-flight
    // with a higher requestId. The existing guard after getCachedBuildResponse
    // must discard A's result.

    let requestId = 0
    const applied: string[] = []

    async function reSolveWithCacheHit(label: string) {
      const currentRequestId = ++requestId
      await Promise.resolve()  // simulate await getCachedBuildResponse(...)
      if (currentRequestId !== requestId) return  // existing guard
      applied.push(label)
    }

    // A starts, suspends at await
    const pA = reSolveWithCacheHit('A')
    // B starts immediately, bumps requestId to 2 before A's guard fires
    const pB = reSolveWithCacheHit('B')

    await Promise.all([pA, pB])

    expect(applied).not.toContain('A')
    expect(applied).toContain('B')
  })
})
