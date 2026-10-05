// The part-editor pairing test the assembly editor already had
// (useAssemblySolve.staleness.test.tsx): a solve started before an undo must be
// dropped by useSolver's request-id guard, and the undo's own re-solve must win.
// Uses the real usePartDoc and the real useSolver, so the guard and the undo
// funnel compose exactly as they do in production.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const h = vi.hoisted(() => ({
  solveViaWorker: vi.fn(),
}))

vi.mock('@/kernel/worker/solverClient', () => ({
  solveViaWorker: h.solveViaWorker,
}))
vi.mock('@/utils/geometry/geometryMapping', () => ({ unflattenGeometry: vi.fn().mockReturnValue({}) }))

import { usePartDoc } from '@/hooks/usePartDoc'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useSolverStore } from '@/stores/solverStore'
import type { PartDoc, Mutation } from '@/types/cad'

const docRef: { current: PartDoc | null } = { current: null }

vi.mock('@/hooks/useDocumentState', () => ({
  useDocumentState: () => ({
    doc: docRef.current, docRef, docName: 'test', setDocName: vi.fn(),
    setDoc: (d: PartDoc) => { docRef.current = d },
    loading: false, error: null, setError: vi.fn(),
    saveDoc: vi.fn(), renameDoc: vi.fn(), cloneDoc: vi.fn(),
  }),
  BUILTIN_FEATURE_DEFAULTS: {},
  BUILTIN_FEATURE_IDS: new Set<string>(),
}))

const renameTo = (label: string): Mutation =>
  ({ type: 'rename_feature', featureId: 'f1', label }) as Mutation

const labelOf = () => (docRef.current?.features?.[0] as { label?: string } | undefined)?.label

describe('usePartDoc undo vs an in-flight solve', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    docRef.current = {
      version: 1, kind: 'part',
      features: [{ id: 'f1', kind: 'sketch', label: 'first' }],
    } as unknown as PartDoc
    usePartEditorStore.getState().setEditingFeatureId(null)
    usePartEditorStore.getState().setRollbackPosition(null)
    usePartEditorStore.getState().setPickBoundary(null)
    useSolverStore.setState({ isSolving: false, onCancelSolve: null })
  })

  it('drops a pre-undo solve result and lets the queued restored-doc solve win', async () => {
    let releaseA!: () => void
    const gateA = new Promise<void>(r => { releaseA = r })
    let releaseB!: () => void
    const gateB = new Promise<void>(r => { releaseB = r })
    h.solveViaWorker
      // Solve #1 is for the renamed doc; its marker would be wrong on the
      // doc undo restores.
      .mockImplementationOnce(async () => {
        await gateA
        return { result: { marker: { status: 'ok' } }, bodies: {}, _build_state: null }
      })
      // Solve #2 is the restored doc's own re-solve.
      .mockImplementationOnce(async () => {
        await gateB
        return { result: { f1: { status: 'ok' } }, bodies: {}, _build_state: null }
      })

    const { result } = renderHook(() => usePartDoc('doc-1', { solveOnLoad: false }))

    // The rename pushes its entry and starts solve #1.
    act(() => { result.current.handleMutation(renameTo('a')) })
    expect(h.solveViaWorker).toHaveBeenCalledTimes(1)
    expect(labelOf()).toBe('a')

    // Undo restores the pre-rename doc and starts solve #2 before #1 lands.
    await act(async () => { result.current.handleUndo() })
    expect(labelOf()).toBe('first')
    expect(h.solveViaWorker).toHaveBeenCalledTimes(2)

    // Solve #1 resolves late: it must be dropped, not painted over the restore.
    await act(async () => { releaseA(); await gateA })
    expect(labelOf()).toBe('first')
    expect(result.current.solveResults).not.toHaveProperty('marker')
    expect(result.current.solveError).toBeNull()

    // Solve #2 lands and owns the record; the doc stays the restored one.
    await act(async () => { releaseB(); await gateB })
    expect(result.current.solveResults).toHaveProperty('f1')
    expect(labelOf()).toBe('first')
    expect(h.solveViaWorker).toHaveBeenCalledTimes(2)
  })
})
