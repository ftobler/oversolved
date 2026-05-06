import { describe, it, expect } from 'vitest'

describe('stale geometry frame guard pattern', () => {
  it('discards binary frame when msgId does not match last valid', () => {
    // This tests the pattern used in usePartDoc:
    //   if (lastValidMsgIdRef.current !== null &&
    //       msgId !== lastValidMsgIdRef.current) return

    function isStale(lastValidMsgId: number | null, msgId: number): boolean {
      return lastValidMsgId !== null && msgId !== lastValidMsgId
    }

    // Simulate solve A: JSON arrives, sets lastValidMsgId = 1
    // Binary for solve A arrives (msgId 1 === lastValidMsgId 1) -> not stale
    expect(isStale(1, 1)).toBe(false)

    // Simulate solve B: JSON arrives, sets lastValidMsgId = 2
    // Binary for solve A arrives LATE (msgId 1 !== lastValidMsgId 2) -> stale!
    expect(isStale(2, 1)).toBe(true)
    // Binary for solve B arrives (msgId 2 === lastValidMsgId 2) -> not stale
    expect(isStale(2, 2)).toBe(false)
  })

  it('processes first binary frame when lastValidMsgId is null', () => {
    // Before any solve completes, lastValidMsgId is null.
    // Binary frames should still be processed (no guard until first JSON arrives).
    function isStale(lastValidMsgId: number | null, msgId: number): boolean {
      return lastValidMsgId !== null && msgId !== lastValidMsgId
    }

    // First binary frame arrives before any JSON solve_result
    expect(isStale(null, 1)).toBe(false)
  })

  it('msgId tracking survives multiple solves in flight', () => {
    function isStale(lastValidMsgId: number | null, msgId: number): boolean {
      return lastValidMsgId !== null && msgId !== lastValidMsgId
    }

    // Solve 1: JSON arrives
    expect(isStale(1, 1)).toBe(false)

    // Solve 2: starts before binary of solve 1 arrives
    // Binary of solve 1 arrives late
    expect(isStale(2, 1)).toBe(true)
    // Binary of solve 2 arrives in order
    expect(isStale(2, 2)).toBe(false)

    // Solve 3
    expect(isStale(3, 1)).toBe(true)
    expect(isStale(3, 2)).toBe(true)
    expect(isStale(3, 3)).toBe(false)
  })
})
