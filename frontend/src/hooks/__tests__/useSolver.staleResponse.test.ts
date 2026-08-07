/**
 * Regression tests for the stale-result guard in useSolver.reSolve.
 *
 * User invariant (solver_arch.user.md §Versioned Solves / #220):
 *   "A response that arrives after a newer reSolve has started must be
 *    silently dropped. Only the response whose request_version matches the
 *    current counter is applied."
 *
 * Defends #220 (request_version monotonic guard) and the isStale() check
 * at useSolver.ts after `await solveLocally(...)`.  Without this test,
 * a future refactor of the stale predicate could silently break the race
 * protection and allow an out-of-order response to corrupt solver state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const { mockSolveLocally } = vi.hoisted(() => ({ mockSolveLocally: vi.fn() }))

vi.mock('@/kernel/worker/solverClient', () => ({ solveViaWorker: mockSolveLocally }))
vi.mock('@/utils/geometry/geometryMapping', () => ({ unflattenGeometry: vi.fn().mockReturnValue({}) }))
vi.mock('@/stores/solverStore', () => ({
  useSolverStore: { getState: () => ({ setIsSolving: vi.fn(), setOnCancelSolve: vi.fn(), onCancelSolve: null }) },
}))

import { useSolver } from '@/hooks/useSolver'
import type { PartDoc } from '@/types/cad'

// A doc with one ported feature so reSolve routes through the local kernel.
function makeDoc(overrides?: Partial<PartDoc>): PartDoc {
  return { oversolved: 1, kind: 'part', features: [{ id: 'feat1', kind: 'sketch', entities: [] }], ...overrides }
}

function setupHook() {
  const docRef = { current: makeDoc() }
  const setDoc = vi.fn()
  const modeRef = { current: 'feature' }
  const setCodeText = vi.fn()
  const { result, unmount } = renderHook(() =>
    useSolver(undefined, setCodeText, modeRef, {}, docRef, setDoc),
  )
  return { result, unmount }
}

describe('useSolver stale-result guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('v1 response dropped when v2 is already in flight', async () => {
    // Defends: isStale() check at useSolver.ts after await solveLocally().
    // Simulates concurrent solves where request_version=1 resolves AFTER
    // request_version=2 has already been issued.
    const { result } = setupHook()

    let resolveV1!: (v: unknown) => void
    let resolveV2!: (v: unknown) => void
    const v1Promise = new Promise(r => { resolveV1 = r })
    const v2Promise = new Promise(r => { resolveV2 = r })

    // First solve: returns pending promise (v1 in flight).
    // Second solve: returns pending promise (v2 in flight).
    mockSolveLocally
      .mockReturnValueOnce(v1Promise)
      .mockReturnValueOnce(v2Promise)

    let p1!: Promise<void>, p2!: Promise<void>
    // Start both reSolves without awaiting. Each increments requestIdRef
    // synchronously before yielding at await solveLocally().
    act(() => { p1 = result.current.reSolve(makeDoc()) })
    act(() => { p2 = result.current.reSolve(makeDoc()) })

    // Resolve v1 first. requestIdRef is now 2, but v1's currentRequestId=1
    // so isStale() returns true and the response is dropped.
    const v1Response = {
      solve_ms: 0,
      result: { stale_feature: { status: 'ok' } },
      bodies: {},
      _build_state: null,
      request_version: 1,
    }
    await act(async () => { resolveV1(v1Response) })

    // v1 was stale -- solveResults must NOT contain the stale key.
    expect(result.current.solveResults).not.toHaveProperty('stale_feature')

    // Resolve v2 (fresh). Its currentRequestId=2 matches requestIdRef=2.
    const v2Response = {
      solve_ms: 0,
      result: {},
      bodies: {},
      _build_state: null,
      request_version: 2,
    }
    await act(async () => {
      resolveV2(v2Response)
      await Promise.all([p1, p2])
    })

    expect(result.current.solveError).toBeNull()
    expect(result.current.solveResults).not.toHaveProperty('stale_feature')
  })

  it('does not lose a fresh response when it is the only call', async () => {
    // Sanity check: a single reSolve with no concurrent request still applies.
    const { result } = setupHook()

    mockSolveLocally.mockResolvedValue({
      solve_ms: 0,
      result: { feat1: { status: 'ok' } },
      bodies: {},
      _build_state: null,
      request_version: 1,
    })

    await act(async () => { await result.current.reSolve(makeDoc()) })
    expect(result.current.solveError).toBeNull()
  })

  it('stale null result must not banner nor clear solving under a newer solve', async () => {
    // Defends the isStale() guard moved above the `if (!local)` branch:
    // a v1 solve that resolves null AFTER v2 bumped the request id must exit
    // before setSolveError/setSolving run, or it paints "Local solver
    // unavailable" and drops the spinner while v2 is still in flight.
    const { result } = setupHook()

    let resolveV1!: (v: unknown) => void
    let resolveV2!: (v: unknown) => void
    const v1Promise = new Promise(r => { resolveV1 = r })
    const v2Promise = new Promise(r => { resolveV2 = r })

    mockSolveLocally
      .mockReturnValueOnce(v1Promise)
      .mockReturnValueOnce(v2Promise)

    let p1!: Promise<void>, p2!: Promise<void>
    act(() => { p1 = result.current.reSolve(makeDoc()) })
    act(() => { p2 = result.current.reSolve(makeDoc()) })

    // v1 is stale by the time it resolves null; it must be dropped entirely.
    await act(async () => { resolveV1(null) })

    expect(result.current.solveError).toBeNull()
    expect(result.current.solving).toBe(true)

    const v2Response = {
      solve_ms: 0,
      result: { feat1: { status: 'ok' } },
      bodies: {},
      _build_state: null,
      request_version: 2,
    }
    await act(async () => {
      resolveV2(v2Response)
      await Promise.all([p1, p2])
    })

    expect(result.current.solveError).toBeNull()
    expect(result.current.solving).toBe(false)
  })

  it('stale non-benign failure must not banner under a newer solve', async () => {
    // Defends the isStale() guard added to the catch path: a stale non-benign
    // rejection (e.g. "kernel boom") must not paint a banner, since the newer
    // solve's benign outcome will never clear it.
    const { result } = setupHook()

    let rejectV1!: (e: Error) => void
    let resolveV2!: (v: unknown) => void
    const v1Promise = new Promise((_, rej) => { rejectV1 = rej })
    const v2Promise = new Promise(r => { resolveV2 = r })

    mockSolveLocally
      .mockReturnValueOnce(v1Promise)
      .mockReturnValueOnce(v2Promise)

    let p1!: Promise<void>, p2!: Promise<void>
    act(() => { p1 = result.current.reSolve(makeDoc()) })
    act(() => { p2 = result.current.reSolve(makeDoc()) })

    await act(async () => { rejectV1(new Error('kernel boom')) })

    expect(result.current.solveError).toBeNull()
    expect(result.current.solving).toBe(true)

    const v2Response = {
      solve_ms: 0,
      result: { feat1: { status: 'ok' } },
      bodies: {},
      _build_state: null,
      request_version: 2,
    }
    await act(async () => {
      resolveV2(v2Response)
      await Promise.all([p1, p2])
    })

    expect(result.current.solveError).toBeNull()
    expect(result.current.solving).toBe(false)
  })

  it('non-stale null result still surfaces the unavailable banner', async () => {
    // Regression: a fresh null resolve (no newer solve in flight) must still
    // reach the error banner and clear the spinner.
    const { result } = setupHook()

    mockSolveLocally.mockResolvedValue(null)

    await act(async () => { await result.current.reSolve(makeDoc()) })
    expect(result.current.solveError).toBe('Local solver unavailable (OCC.js failed to load)')
    expect(result.current.solving).toBe(false)
  })

  it('non-stale non-benign failure still banners', async () => {
    // Regression: a fresh non-benign rejection must still paint the banner.
    // Uses "kernel boom", not a crash string: crashes are benign by design now
    // (they are surfaced by the console error and the crash cooldown).
    const { result } = setupHook()

    mockSolveLocally.mockRejectedValue(new Error('kernel boom'))

    await act(async () => { await result.current.reSolve(makeDoc()) })
    expect(result.current.solveError).toBe('Error: kernel boom')
  })
})
