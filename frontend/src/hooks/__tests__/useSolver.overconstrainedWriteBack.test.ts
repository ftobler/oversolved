// @vitest-environment jsdom
//
// The browser adapter applies the same write-back gate as the headless one: an
// overconstrained sketch keeps the last good (or authored) geometry instead of
// installing the solver's compromise.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const { mockSolveLocally, mockUnflattenGeometry, cancelSolverMock } = vi.hoisted(() => ({
  mockSolveLocally: vi.fn(),
  mockUnflattenGeometry: vi.fn().mockReturnValue({}),
  cancelSolverMock: vi.fn(),
}))

vi.mock('@/kernel/worker/solverClient', () => ({
  solveViaWorker: mockSolveLocally,
  cancelSolver: cancelSolverMock,
}))
vi.mock('@/utils/geometry/geometryMapping', () => ({ unflattenGeometry: mockUnflattenGeometry }))

import { useSolver } from '@/hooks/useSolver'
import { useSolverStore } from '@/stores/solverStore'
import type { BodyResult, PartDoc } from '@/types/cad'
import { useEditorState } from '@/hooks/useEditorState'

function sketch(id: string, entityId: string, initial: number[]): Record<string, unknown> {
  return { id, kind: 'sketch', entities: [{ id: entityId, kind: 'line' }], initial: { [entityId]: initial } }
}

function makeDoc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [sketch('sk1', 'l1', [0, 0, 2, 0]), sketch('sk2', 'l2', [1, 2, 3, 4])],
  } as unknown as PartDoc
}

function response(result: Record<string, unknown>) {
  return { solve_ms: 0, result, bodies: {} as Record<string, BodyResult>, _build_state: null }
}

function setupHook(doc: PartDoc) {
  const docRef: { current: PartDoc } = { current: doc }
  const setDoc = vi.fn()
  const { result } = renderHook(() => useSolver('u', {}, docRef, setDoc))
  return { result, docRef, setDoc }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockUnflattenGeometry.mockReturnValue({})
  useEditorState.setState({ editingFeatureId: null, rollbackPosition: null, pickBoundary: null })
  useSolverStore.setState({ isSolving: false, onCancelSolve: null })
})

describe('applySolveResult and a failed sketch', () => {
  it('bakes the sibling but leaves an overconstrained sketch alone', async () => {
    const doc = makeDoc()
    const { result, setDoc } = setupHook(doc)
    mockSolveLocally.mockResolvedValue(response({
      sk1: { status: 'overconstrained', geometry: { l1: [0, 0, 9, 0] } },
      sk2: { status: 'underconstrained', geometry: { l2: [5, 6, 7, 8] } },
    }))

    await act(async () => { await result.current.reSolve(doc) })

    expect(setDoc).toHaveBeenCalledTimes(1)
    const written = setDoc.mock.calls[0][0] as PartDoc
    const sk1 = written.features!.find(f => f.id === 'sk1') as { initial?: Record<string, number[]> }
    const sk2 = written.features!.find(f => f.id === 'sk2') as { initial?: Record<string, number[]> }
    expect(sk1.initial).toEqual({ l1: [0, 0, 2, 0] })
    expect(sk2.initial).toEqual({ l2: [5, 6, 7, 8] })
    // The failed sketch still renders its best-effort solve.
    expect(result.current.solveResults.sk1.status).toBe('overconstrained')
  })

  it('mints no doc object when the only sketch failed', async () => {
    const doc = makeDoc()
    const { result, setDoc } = setupHook(doc)
    mockSolveLocally.mockResolvedValue(response({
      sk1: { status: 'overconstrained', geometry: { l1: [0, 0, 9, 0] } },
    }))

    await act(async () => { await result.current.reSolve(doc) })

    expect(setDoc).not.toHaveBeenCalled()
  })

  it('a grouped sketch with a conflicting length keeps its held shape', async () => {
    // The solver's compromise stretches a group member; baking it would teach
    // the group a deformed reference on the next solve. The failed solve must
    // leave `initial` at the last satisfied geometry.
    const doc = {
      version: 1,
      kind: 'part',
      features: [
        {
          id: 'sk1',
          kind: 'sketch',
          entities: [{ id: 'l1', kind: 'line' }, { id: 'c1', kind: 'circle' }],
          initial: { l1: [0, 0, 4, 0], c1: [6, 0, 1] },
          constraints: [
            { id: 'g1', kind: 'group', refs: ['$l1', '$c1'] },
            { id: 'len', kind: 'length', target: '$l1', value: 10 },
          ],
        },
        sketch('sk2', 'l2', [1, 2, 3, 4]),
      ],
    } as unknown as PartDoc
    const { result, setDoc } = setupHook(doc)
    mockSolveLocally.mockResolvedValue(response({
      sk1: {
        status: 'overconstrained',
        geometry: { l1: [0, 0, 10, 0], c1: [12, 0, 1] },
      },
      sk2: { status: 'underconstrained', geometry: { l2: [5, 6, 7, 8] } },
    }))

    await act(async () => { await result.current.reSolve(doc) })

    expect(setDoc).toHaveBeenCalledTimes(1)
    const written = setDoc.mock.calls[0][0] as PartDoc
    const sk1 = written.features!.find(f => f.id === 'sk1') as { initial?: Record<string, number[]> }
    expect(sk1.initial).toEqual({ l1: [0, 0, 4, 0], c1: [6, 0, 1] })
    // The group itself is still there for the next edit/undo.
    expect((written.features!.find(f => f.id === 'sk1') as { constraints?: unknown[] }).constraints)
      .toHaveLength(2)
  })
})
