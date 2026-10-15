/**
 * ST-L1 regression: the solver write-back must not defeat the save identity
 * guard. applySolveResult used to mint a fresh doc object on every solve, so a
 * re-solve overlapping a save would swap docRef identity and stop the save from
 * clearing the dirty flag. A re-solve that re-derives identical geometry must
 * keep the prior doc object (no identity swap); a solve that actually changes
 * the doc still swaps it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const { mockSolveViaWorker } = vi.hoisted(() => ({ mockSolveViaWorker: vi.fn() }))

vi.mock('@/kernel/worker/solverClient', () => ({ solveViaWorker: mockSolveViaWorker, cancelSolver: vi.fn() }))
vi.mock('@/utils/geometry/geometryMapping', () => ({ unflattenGeometry: vi.fn().mockReturnValue({}) }))
vi.mock('@/stores/solverStore', () => ({
  useSolverStore: { getState: () => ({ setIsSolving: vi.fn(), setOnCancelSolve: vi.fn(), onCancelSolve: null }) },
}))

import { useSolver } from '@/hooks/useSolver'
import type { PartDoc } from '@/types/cad'

function makeDoc(initial?: Record<string, number[]>): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [{
      id: 'sk1',
      kind: 'sketch',
      entities: [
        { id: 'l1', kind: 'line' },
        { id: 'l2', kind: 'line' },
      ],
      initial: initial ?? {},
    }],
  }
}

// Solved params reach the main thread as f64 now (wasm-kernel/codec.ts
// decodeOutput, rev 3), but documents authored under the rev 2 f32 wire carry
// spellings like 3.1415927410125732 where the sketch mutator persisted
// round(3.1415927...) = 3.141593. Same geometry, different digits, and a doc
// compare that reads the difference as a change. The suite keeps exercising
// that legacy band.
const F32_PI = Math.fround(Math.PI)
const F32_THIRD = Math.fround(1 / 3)

function response(geom: Record<string, number[]>): Record<string, unknown> {
  return {
    solve_ms: 0,
    result: { sk1: { status: 'ok', geometry: geom } },
    bodies: {},
    _build_state: null,
  }
}

describe('solver write-back preserves doc identity on unchanged geometry', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('keeps docRef identity across a re-solve that bakes identical geometry', async () => {
    const docRef: { current: PartDoc | null } = { current: makeDoc() }
    const setDoc = vi.fn((d: PartDoc | null | ((prev: PartDoc | null) => PartDoc | null)) => {
      docRef.current = typeof d === 'function' ? d(docRef.current) : d
    })
    const { result } = renderHook(() =>
      useSolver(undefined, {}, docRef, setDoc),
    )

    mockSolveViaWorker.mockResolvedValue(response({ l1: [0, 0, 1, 0], l2: [0, 5, 1, 5] }))
    await act(async () => { await result.current.reSolve(makeDoc()) })
    const afterFirst = docRef.current
    expect(setDoc).toHaveBeenCalledTimes(1)

    // Second solve, identical geometry: must NOT swap identity.
    mockSolveViaWorker.mockResolvedValue(response({ l1: [0, 0, 1, 0], l2: [0, 5, 1, 5] }))
    await act(async () => { await result.current.reSolve(makeDoc()) })
    expect(docRef.current).toBe(afterFirst)
    expect(setDoc).toHaveBeenCalledTimes(1)
  })

  it('still swaps identity when the solved geometry actually changes', async () => {
    const docRef: { current: PartDoc | null } = { current: makeDoc() }
    const setDoc = vi.fn((d: PartDoc | null | ((prev: PartDoc | null) => PartDoc | null)) => {
      docRef.current = typeof d === 'function' ? d(docRef.current) : d
    })
    const { result } = renderHook(() =>
      useSolver(undefined, {}, docRef, setDoc),
    )

    mockSolveViaWorker.mockResolvedValue(response({ l1: [0, 0, 1, 0], l2: [0, 5, 1, 5] }))
    await act(async () => { await result.current.reSolve(makeDoc()) })
    const afterFirst = docRef.current

    mockSolveViaWorker.mockResolvedValue(response({ l1: [0, 0, 2, 0], l2: [0, 5, 2, 5] }))
    await act(async () => { await result.current.reSolve(makeDoc()) })
    expect(docRef.current).not.toBe(afterFirst)
    expect(setDoc).toHaveBeenCalledTimes(2)
  })

  // The binary-exact case above passes either way: identical input, identical
  // output. The rounding matters when the doc on the other side of the compare
  // was written by a mutator, which persists to 6dp.
  it('keeps docRef identity when the solve re-derives geometry the mutator already wrote rounded', async () => {
    const rounded = { l1: [0, 0, 3.141593, 0], l2: [0, 5, 0.333333, 5] }
    const docRef: { current: PartDoc | null } = { current: makeDoc(structuredClone(rounded)) }
    const setDoc = vi.fn()
    const { result } = renderHook(() =>
      useSolver(undefined, {}, docRef, setDoc),
    )
    const before = docRef.current

    mockSolveViaWorker.mockResolvedValue(response({ l1: [0, 0, F32_PI, 0], l2: [0, 5, F32_THIRD, 5] }))
    await act(async () => { await result.current.reSolve(docRef.current!) })

    // Unrounded, the f32 digits differ from the 6dp ones the mutator wrote, the
    // compare fails, and the re-solve mints a fresh doc object -- which is what
    // defeats a save that overlaps it.
    expect(setDoc).not.toHaveBeenCalled()
    expect(docRef.current).toBe(before)
  })

  it('bakes the rounded value rather than the raw wire value', async () => {
    const docRef: { current: PartDoc | null } = { current: makeDoc() }
    const setDoc = vi.fn((d: PartDoc | null | ((prev: PartDoc | null) => PartDoc | null)) => {
      docRef.current = typeof d === 'function' ? d(docRef.current) : d
    })
    const { result } = renderHook(() =>
      useSolver(undefined, {}, docRef, setDoc),
    )

    mockSolveViaWorker.mockResolvedValue(response({ l1: [0, 0, F32_PI, 0], l2: [0, 5, F32_THIRD, 5] }))
    await act(async () => { await result.current.reSolve(docRef.current!) })

    expect(setDoc).toHaveBeenCalledTimes(1)
    const initial = (docRef.current!.features![0] as { initial: Record<string, number[]> }).initial
    expect(initial).toEqual({ l1: [0, 0, 3.141593, 0], l2: [0, 5, 0.333333, 5] })
    expect(initial.l1[2]).not.toBe(F32_PI)
  })

  // The legacy band where the f32 quantum is wider than the mutators' 6dp grid,
  // so rounding a rev 2 wire value does NOT recover the authored number: 25.7
  // solved to 25.700000762939453, which rounds to 25.700001, and 63.4 to
  // 63.400002. Rounding alone therefore still minted a fresh doc object here,
  // which is what defeated a save overlapping the re-solve.
  const F32_BAND = [[25.7, 25.700001], [47.3, 47.299999], [63.4, 63.400002], [100.000001, 100]] as const

  it.each(F32_BAND)('keeps docRef identity when the solve re-derives %s as f32', async (authored) => {
    const docRef: { current: PartDoc | null } = {
      current: makeDoc({ l1: [0, 0, authored, 0], l2: [0, 5, authored, 5] }),
    }
    const setDoc = vi.fn()
    const { result } = renderHook(() =>
      useSolver(undefined, {}, docRef, setDoc),
    )
    const before = docRef.current

    mockSolveViaWorker.mockResolvedValue(response({
      l1: [0, 0, Math.fround(authored), 0],
      l2: [0, 5, Math.fround(authored), 5],
    }))
    await act(async () => { await result.current.reSolve(docRef.current!) })

    // The write-back keeps the authored spelling, so the clone it compared is
    // byte-identical to the live doc: no fresh object, docRef untouched.
    expect(setDoc).not.toHaveBeenCalled()
    expect(docRef.current).toBe(before)
    const initial = (docRef.current!.features![0] as { initial: Record<string, number[]> }).initial
    expect(initial.l1[2]).toBe(authored)
  })

  it('still swaps identity when the solve moves a band-sized coordinate', async () => {
    // The control for the keep: within the envelope the doc is preserved, but a
    // real move at the same magnitude still installs and swaps identity.
    const docRef: { current: PartDoc | null } = { current: makeDoc({ l1: [0, 0, 25.7, 0] }) }
    const setDoc = vi.fn((d: PartDoc | null | ((prev: PartDoc | null) => PartDoc | null)) => {
      docRef.current = typeof d === 'function' ? d(docRef.current) : d
    })
    const { result } = renderHook(() =>
      useSolver(undefined, {}, docRef, setDoc),
    )
    const before = docRef.current

    mockSolveViaWorker.mockResolvedValue(response({ l1: [0, 0, 26.4, 0] }))
    await act(async () => { await result.current.reSolve(docRef.current!) })

    expect(setDoc).toHaveBeenCalledTimes(1)
    expect(docRef.current).not.toBe(before)
    const initial = (docRef.current!.features![0] as { initial: Record<string, number[]> }).initial
    expect(initial.l1).toEqual([0, 0, 26.4, 0])
  })
})
