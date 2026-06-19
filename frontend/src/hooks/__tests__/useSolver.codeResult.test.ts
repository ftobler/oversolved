/**
 * Tests for the code-tab result dump (Topic 5 / codedebug-solve-result):
 * the raw solve result is serialized lazily (only when mode === 'code') and as
 * JSON, the native shape of the result object -- not on every solve, not YAML.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const { mockSolveLocally } = vi.hoisted(() => ({ mockSolveLocally: vi.fn() }))

vi.mock('@/kernel/worker/solverClient', () => ({ solveViaWorker: mockSolveLocally }))
vi.mock('@/utils/geometry/geometryMapping', () => ({ unflattenGeometry: vi.fn().mockReturnValue({}) }))
vi.mock('@/stores/solverStore', () => ({
  useSolverStore: { getState: () => ({ setIsSolving: vi.fn() }) },
}))

import { useSolver } from '@/hooks/useSolver'
import type { PartDoc, BodyResult } from '@/types/cad'

function makeDoc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [{ id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front', initial: {} }],
  }
}

const RESULT = {
  sk1: { status: 'exception', exception: 'boom', solve_ms: 1 },
}

function setupHook(mode: string) {
  const docRef = { current: makeDoc() }
  const setDoc = vi.fn()
  const setCodeText = vi.fn()
  const { result } = renderHook(() =>
    useSolver(undefined, setCodeText, { current: mode }, {}, docRef, setDoc),
  )
  return { result, setCodeText }
}

describe('useSolver -- code-tab result serialization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSolveLocally.mockResolvedValue({
      solve_ms: 0,
      result: RESULT,
      bodies: {} as Record<string, BodyResult>,
      _build_state: null,
    })
  })

  it('does NOT serialize the result when the code tab is closed', async () => {
    const { result, setCodeText } = setupHook('feature')
    await act(async () => { await result.current.reSolve(makeDoc()) })
    expect(result.current.solveResult).toBe('')
    expect(setCodeText).not.toHaveBeenCalled()
  })

  it('serializes the result as JSON (not YAML) when the code tab is open', async () => {
    const { result } = setupHook('code')
    await act(async () => { await result.current.reSolve(makeDoc()) })
    expect(result.current.solveResult).toBe(JSON.stringify(RESULT, null, 2))
    // JSON, not YAML: round-trips and has no YAML key syntax.
    expect(JSON.parse(result.current.solveResult)).toEqual(RESULT)
    expect(result.current.solveResult).not.toMatch(/^sk1:/m)
  })
})
