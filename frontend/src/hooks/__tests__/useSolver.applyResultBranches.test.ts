// The applySolveResult/reSolve branches the main useSolver suite does not reach:
// projection kind resolution, constraint render positions, per-feature transform
// fields, drag-anchor threading, a feature-less doc, a phantom editing feature,
// and a non-Error rejection.
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

import { useSolver, reconcilePartStyle } from '@/hooks/useSolver'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useSolverStore } from '@/stores/solverStore'
import type { PartDoc, BodyResult } from '@/types/cad'

function makeDoc(overrides?: Partial<PartDoc>): PartDoc {
  return { version: 1, kind: 'part', features: [], ...overrides }
}

function setupHook(doc: PartDoc = makeDoc()) {
  const docRef = { current: doc }
  const setDoc = vi.fn()
  const { result } = renderHook(() => useSolver('u', {}, docRef, setDoc))
  return { result, docRef, setDoc }
}

function response(result: Record<string, unknown>) {
  return { solve_ms: 0, result, bodies: {} as Record<string, BodyResult>, _build_state: null }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockUnflattenGeometry.mockReturnValue({})
  usePartEditorStore.setState({ editingFeatureId: null, rollbackPosition: null, pickBoundary: null })
  useSolverStore.setState({ isSolving: false, onCancelSolve: null })
})

describe('reconcilePartStyle unnamed entries', () => {
  it('treats a missing entry name as unnamed when numbering new bodies', () => {
    const doc = makeDoc({ part_style: { a: { color: '#ff0000' } } })
    reconcilePartStyle(doc, { a: { id: 'a', created_by: 'x', modified_by: [] }, b: { id: 'b', created_by: 'y', modified_by: [] } })
    // No "part N" was claimed by the unnamed entry, so b takes part 1.
    expect(doc.part_style?.b?.name).toBe('part 1')
  })
})

describe('applySolveResult branches', () => {
  it('lets a resolved entity kind override the authored kind handed to unflattenGeometry', async () => {
    const { result } = setupHook(makeDoc({
      features: [{ id: 'sk1', kind: 'sketch', entities: [{ id: 'e1', kind: 'circle' }] }],
    }))
    mockSolveLocally.mockResolvedValue(response({
      sk1: { status: 'ok', geometry: {}, resolved_kinds: { e1: 'ellipse' } },
    }))

    await act(async () => { await result.current.reSolve(makeDoc({
      features: [{ id: 'sk1', kind: 'sketch', entities: [{ id: 'e1', kind: 'circle' }] }],
    })) })

    const entities = mockUnflattenGeometry.mock.calls[0][1] as { id: string; kind: string }[]
    expect(entities[0]).toMatchObject({ id: 'e1', kind: 'ellipse' })
  })

  it('merges an authored constraint position into the solved render', async () => {
    const { result } = setupHook()
    mockSolveLocally.mockResolvedValue(response({
      sk1: {
        status: 'ok',
        geometry: {},
        constraints: { c1: { residual: 0.5, render: { kind: 'horizontal' }, superfluous: false } },
      },
    }))
    const doc = makeDoc({
      features: [{
        id: 'sk1', kind: 'sketch',
        constraints: [{ id: 'c1', kind: 'horizontal', pos: [3, 4] }],
      }],
    })

    await act(async () => { await result.current.reSolve(doc) })

    const solved = result.current.solveResults.sk1.constraints!.c1
    expect((solved.render as { pos?: [number, number] }).pos).toEqual([3, 4])
    expect(solved.render.kind).toBe('horizontal')
  })

  it('carries originLocal and plane_transform on a geometry result', async () => {
    const { result } = setupHook()
    mockSolveLocally.mockResolvedValue(response({
      sk1: {
        status: 'ok',
        geometry: {},
        originLocal: [1, 2],
        plane_transform: { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], origin: [0, 0, 0] },
      },
    }))
    const doc = makeDoc({ features: [{ id: 'sk1', kind: 'sketch', entities: [] }] })

    await act(async () => { await result.current.reSolve(doc) })

    expect(result.current.solveResults.sk1.originLocal).toEqual([1, 2])
    expect(result.current.solveResults.sk1.plane_transform?.origin).toEqual([0, 0, 0])
  })

  it('defaults only a missing status to exception and keeps a present one', async () => {
    const { result } = setupHook()
    mockSolveLocally.mockResolvedValue(response({
      v1: { status: 'partial', value: 5 },
      v2: { value: 7 },
    }))
    const doc = makeDoc({ features: [{ id: 'v1', kind: 'variable' }, { id: 'v2', kind: 'variable' }] })

    await act(async () => { await result.current.reSolve(doc) })

    expect(result.current.solveResults.v1.status).toBe('partial')
    expect(result.current.solveResults.v2.status).toBe('exception')
  })
})

describe('reSolve drag anchor and doc shape', () => {
  it('threads the drag anchor onto the matching feature payload only', async () => {
    const { result } = setupHook()
    const doc = makeDoc({
      features: [{ id: 'sk1', kind: 'sketch', entities: [] }, { id: 'sk2', kind: 'sketch', entities: [] }],
    })

    await act(async () => {
      await result.current.reSolve(doc, { dragAnchor: { featureId: 'sk2', entityId: 'e1' } })
    })

    const payloadFeatures = mockSolveLocally.mock.calls[0][0].features as { id: string; drag_anchor?: string }[]
    expect(payloadFeatures.find(f => f.id === 'sk1')?.drag_anchor).toBeUndefined()
    expect(payloadFeatures.find(f => f.id === 'sk2')?.drag_anchor).toBe('e1')
  })

  it('treats a doc without a features array as empty without invoking the solver', async () => {
    const { result } = setupHook()
    await act(async () => { await result.current.reSolve({ version: 1, kind: 'part' } as PartDoc) })
    expect(mockSolveLocally).not.toHaveBeenCalled()
    expect(result.current.solveError).toBeNull()
  })

  it('does not fail the edit invariant for a phantom editing feature the doc lacks', async () => {
    const { result } = setupHook()
    usePartEditorStore.setState({ editingFeatureId: 'ghost', rollbackPosition: 1, pickBoundary: 0 })
    mockSolveLocally.mockResolvedValue(response({}))
    const doc = makeDoc({ features: [{ id: 'sk1', kind: 'sketch', entities: [] }] })

    await act(async () => { await result.current.reSolve(doc) })

    // The FSM has not synced to the doc yet (add+enter); the invariant bows out.
    expect(result.current.solveError).toBeNull()
  })

  it('does not fail the edit invariant for a featureless doc while editing', async () => {
    const { result } = setupHook()
    usePartEditorStore.setState({ editingFeatureId: 'ghost', rollbackPosition: null, pickBoundary: 0 })

    await act(async () => { await result.current.reSolve({ version: 1, kind: 'part' } as PartDoc) })

    expect(mockSolveLocally).not.toHaveBeenCalled()
    expect(result.current.solveError).toBeNull()
  })

  it('surfaces a non-Error rejection reason', async () => {
    const { result } = setupHook()
    mockSolveLocally.mockRejectedValue('kernel exploded as a string')
    const doc = makeDoc({ features: [{ id: 'sk1', kind: 'sketch', entities: [] }] })

    await act(async () => { await result.current.reSolve(doc) })

    expect(result.current.solveError).toBe('kernel exploded as a string')
  })

  it('wires the solver store cancel handler to cancelSolver', () => {
    setupHook()
    const handler = useSolverStore.getState().onCancelSolve
    expect(handler).toBeTypeOf('function')
    handler!()
    expect(cancelSolverMock).toHaveBeenCalledTimes(1)
  })
})
