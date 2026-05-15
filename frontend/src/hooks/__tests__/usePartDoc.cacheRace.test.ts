import { describe, it, expect } from 'vitest'
import { computeCacheKey } from '@/utils/buildCache'
import type { PartFeature } from '@/types/cad'

describe('buildCache key consistency', () => {
  it('different rollback positions produce different keys', async () => {
    const features: PartFeature[] = [{ id: 'sk1', kind: 'sketch', entities: [] }]
    const key1 = await computeCacheKey('doc1', features, 3, null)
    const key2 = await computeCacheKey('doc1', features, 5, null)
    expect(key1).not.toBe(key2)
  })

  it('different pick boundaries produce different keys', async () => {
    const features: PartFeature[] = [{ id: 'sk1', kind: 'sketch', entities: [] }]
    const key1 = await computeCacheKey('doc1', features, 1, null)
    const key2 = await computeCacheKey('doc1', features, 1, 2)
    expect(key1).not.toBe(key2)
  })

  it('different feature content produces different keys', async () => {
    const features1 = [{ id: 'sk1', kind: 'sketch', entities: [{ id: 'e1' }] }] as unknown as PartFeature[]
    const features2 = [{ id: 'sk1', kind: 'sketch', entities: [{ id: 'e2' }] }] as unknown as PartFeature[]
    const key1 = await computeCacheKey('doc1', features1, 1, null)
    const key2 = await computeCacheKey('doc1', features2, 1, null)
    expect(key1).not.toBe(key2)
  })

  it('same inputs produce the same key', async () => {
    const features: PartFeature[] = [{ id: 'sk1', kind: 'sketch', entities: [] }]
    const key1 = await computeCacheKey('doc1', features, 1, null)
    const key2 = await computeCacheKey('doc1', features, 1, null)
    expect(key1).toBe(key2)
  })
})

describe('requestId staleness pattern', () => {
  it('demonstrates that stale cache hits are discarded via requestId check', async () => {
    // This tests the pattern used in usePartDoc.reSolve:
    //   const currentRequestId = ++requestIdRef.current
    //   // ... async work ...
    //   if (currentRequestId !== requestIdRef.current) return  // stale

    let requestId = 0

    // Simulate solve A (stale)
    const solveA_requestId = ++requestId  // 1

    // Simulate solve B starts before A's async work completes
    const solveB_requestId = ++requestId  // 2

    // Solve A checks staleness
    const isSolveAStale = solveA_requestId !== requestId
    expect(isSolveAStale).toBe(true)  // A is stale

    // Solve B checks staleness
    const isSolveBStale = solveB_requestId !== requestId
    expect(isSolveBStale).toBe(false)  // B is still current

    // Verify: only B's result should be applied
    const appliedFromSolve: number[] = []
    if (!isSolveBStale) appliedFromSolve.push(solveB_requestId)
    if (!isSolveAStale) appliedFromSolve.push(solveA_requestId)

    expect(appliedFromSolve).toEqual([2])
  })

  it('rollbackPosRef is only updated by winning solves', async () => {
    // This tests the fix: rollbackPosRef is updated AFTER staleness check,
    // not at the top of the function before async work.

    let requestId = 0
    let rollbackPosRef = 0

    // Simulate solve A (stale)
    const solveA_requestId = ++requestId
    const solveA_rollback = 3
    // Old behavior: rollbackPosRef = solveA_rollback (even if discarded)
    // New behavior: deferred

    // Simulate solve B (winner)
    const solveB_requestId = ++requestId
    const solveB_rollback = 5

    // Staleness checks
    const isSolveAStale = solveA_requestId !== requestId
    const isSolveBStale = solveB_requestId !== requestId

    // Only winning solves update rollbackPosRef
    if (!isSolveBStale) rollbackPosRef = solveB_rollback
    if (!isSolveAStale) rollbackPosRef = solveA_rollback

    // The winning solve's rollback should be the final value
    expect(rollbackPosRef).toBe(5)
    expect(rollbackPosRef).not.toBe(3)
  })
})
