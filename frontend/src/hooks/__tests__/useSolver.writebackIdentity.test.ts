// @vitest-environment jsdom
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

// The solver reports which entities it moved; the doc keeps the authored
// spelling for every one it did not. `F32_PI` and `F32_THIRD` are the rev 2
// wire spellings the old envelope used to absorb, kept here as one spelling
// among the moved-set cases.
const F32_PI = Math.fround(Math.PI)
const F32_THIRD = Math.fround(1 / 3)

function response(geom: Record<string, number[]>, entityMoved: string[] = []): Record<string, unknown> {
  return {
    solve_ms: 0,
    result: { sk1: { status: 'ok', geometry: geom, entity_moved: entityMoved } },
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

    // The solver names no moved entity, so the authored arrays stay.
    mockSolveViaWorker.mockResolvedValue(response({ l1: [0, 0, F32_PI, 0], l2: [0, 5, F32_THIRD, 5] }))
    await act(async () => { await result.current.reSolve(docRef.current!) })

    // Unrounded, the solved digits differ from the 6dp ones the mutator wrote,
    // the compare fails, and the re-solve mints a fresh doc object -- which is
    // what defeats a save that overlaps it.
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

  // The rev 2 band the old envelope existed for. The solver reports the entity
  // unmoved (nothing drives it), so the authored spelling is kept whatever the
  // wire's digits are: rounding alone could not recover 25.7 from 25.700001.
  const REV2_BAND = [[25.7, 25.700001], [47.3, 47.299999], [63.4, 63.400002], [100.000001, 100]] as const

  it.each(REV2_BAND)('keeps docRef identity when an undriven %s re-solves to its rev 2 spelling', async (authored) => {
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
    }, []))
    await act(async () => { await result.current.reSolve(docRef.current!) })

    // The write-back keeps the authored spelling, so the clone it compared is
    // byte-identical to the live doc: no fresh object, docRef untouched.
    expect(setDoc).not.toHaveBeenCalled()
    expect(docRef.current).toBe(before)
    const initial = (docRef.current!.features![0] as { initial: Record<string, number[]> }).initial
    expect(initial.l1[2]).toBe(authored)
  })

  it('still swaps identity when the solve reports the coordinate moved', async () => {
    // The control for the keep: an unmoved entity is preserved, but a solve
    // that names it moved installs the rounded value and swaps identity.
    const docRef: { current: PartDoc | null } = { current: makeDoc({ l1: [0, 0, 25.7, 0] }) }
    const setDoc = vi.fn((d: PartDoc | null | ((prev: PartDoc | null) => PartDoc | null)) => {
      docRef.current = typeof d === 'function' ? d(docRef.current) : d
    })
    const { result } = renderHook(() =>
      useSolver(undefined, {}, docRef, setDoc),
    )
    const before = docRef.current

    mockSolveViaWorker.mockResolvedValue(response({ l1: [0, 0, 26.4, 0] }, ['l1']))
    await act(async () => { await result.current.reSolve(docRef.current!) })

    expect(setDoc).toHaveBeenCalledTimes(1)
    expect(docRef.current).not.toBe(before)
    const initial = (docRef.current!.features![0] as { initial: Record<string, number[]> }).initial
    expect(initial.l1).toEqual([0, 0, 26.4, 0])
  })
})
