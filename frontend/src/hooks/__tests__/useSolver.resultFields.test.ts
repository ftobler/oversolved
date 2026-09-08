/**
 * `applySolveResult` rebuilds every feature result into a fixed shape at the
 * worker -> store seam, so a field it forgets to copy is invisible to the whole
 * UI no matter how correct the kernel was. `body_ids` and `value` were both
 * being dropped, and both have a consumer in the feature tree: the
 * split-sibling mesh-error check fell back to `body_id` alone, and a variable's
 * inline `name = 100` never rendered.
 *
 * This is the seam, not the tree: the sidebar tests write raw solver shapes
 * straight into the store and so cannot catch a drop here.
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
import type { PartDoc, BodyResult } from '@/types/cad'

function makeDoc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [
      { id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front', initial: {} },
      { id: 'ex1', kind: 'extrude', extrude: { profile: 'sk1', distance: 10 } },
      { id: 'v1', kind: 'variable', variable: { expression: '40+60' } },
    ] as PartDoc['features'],
  }
}

function setupHook() {
  const docRef = { current: makeDoc() }
  const { result } = renderHook(() =>
    useSolver(undefined, {}, docRef, vi.fn()),
  )
  return result
}

async function solveWith(result: ReturnType<typeof setupHook>, featureResults: Record<string, unknown>) {
  mockSolveLocally.mockResolvedValue({
    solve_ms: 0,
    result: featureResults,
    bodies: {} as Record<string, BodyResult>,
    _build_state: null,
  })
  await act(async () => { await result.current.reSolve(makeDoc()) })
}

describe('applySolveResult -- fields the feature tree reads', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('keeps every body a feature made, not just the first', async () => {
    const result = setupHook()
    await solveWith(result, { ex1: { status: 'ok', body_id: 'body_ex1', body_ids: ['body_ex1', 'body_ex1_1'] } })
    expect(result.current.solveResults['ex1'].body_ids).toEqual(['body_ex1', 'body_ex1_1'])
  })

  it('keeps the solved value of a variable', async () => {
    const result = setupHook()
    await solveWith(result, { v1: { status: 'ok', value: 100 } })
    expect(result.current.solveResults['v1'].value).toBe(100)
  })

  it('omits both when the result carries neither', async () => {
    const result = setupHook()
    await solveWith(result, { ex1: { status: 'ok', body_id: 'body_ex1' } })
    expect(result.current.solveResults['ex1'].body_ids).toBeUndefined()
    expect(result.current.solveResults['ex1'].value).toBeUndefined()
  })
})
