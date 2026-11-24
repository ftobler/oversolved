// @vitest-environment jsdom
//
// The adapter half of an undo that stays inside an open sketch: the store must
// keep the edited feature (and its rollback bar) instead of bringing the editor
// down, while the page's transient reset still runs and the full teardown does
// not. The engine suite (session/__tests__/undoEngine.test.ts) owns the floor
// decision; these rows pin what usePartDoc makes of it.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'
import { useEditorState } from '@/hooks/useEditorState'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import type { PartDoc, Mutation } from '@/types/cad'
import { docRef, reSolve, resetHarness } from './usePartDoc.undoHarness'

vi.mock('@/hooks/useDocumentState', async () => {
  const { documentStateMock } = await import('./usePartDoc.undoHarness')
  return documentStateMock()
})

vi.mock('@/hooks/useSolver', async () => {
  const { solverMock } = await import('./usePartDoc.undoHarness')
  return solverMock()
})

// The open sketch sits second, so "the edited feature's index + 1" is not the
// same number as the feature count and a wrong rule cannot pass by accident.
const SKETCH_AT_ONE = {
  version: 1,
  kind: 'part',
  features: [
    { id: 'origin', kind: 'origin' },
    { id: 'sk1', kind: 'sketch' },
    { id: 'ex1', kind: 'extrude' },
  ],
} as unknown as PartDoc

const addPoint = (): Mutation =>
  ({ type: 'add_entity', featureId: 'sk1', kind: 'point', params: [1, 2] }) as Mutation

function renderDoc() {
  const view = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
  const teardown = vi.fn()
  const transients = vi.fn()
  view.result.current.registerUndoTeardown(teardown)
  view.result.current.registerInSessionUndo(transients)
  return { result: view.result, teardown, transients }
}

// Production enters the session first, then stamps the feature (enterEditFeature).
function openSketch(result: { current: ReturnType<typeof usePartDoc> }) {
  act(() => { result.current.startEditSession(false) })
  act(() => {
    const store = useEditorState.getState()
    store.setEditingFeatureId('sk1')
    store.setPickBoundary(3)
  })
}

describe('usePartDoc undo inside an open sketch', () => {
  beforeEach(() => {
    resetHarness()
    reSolve.mockReset()
    docRef.current = structuredClone(SKETCH_AT_ONE)
    useEditorState.getState().setPickBoundary(null)
  })

  it('keeps the editor and re-derives its rollback bar, running only the transient reset', () => {
    const { result, teardown, transients } = renderDoc()
    openSketch(result)
    act(() => { result.current.handleMutation(addPoint()) })
    const afterAction = structuredClone(docRef.current)
    act(() => { useEditorState.getState().setRollbackPosition(9) })

    act(() => { result.current.handleUndo() })

    const store = useEditorState.getState()
    // The sketch the entry left belongs to is still open, and the bar sits just
    // past it again rather than at the restored doc's end.
    expect(store.editingFeatureId).toBe('sk1')
    expect(store.pickBoundary).toBe(3)
    expect(store.rollbackPosition).toBe(2)
    expect(docRef.current).not.toEqual(afterAction)
    expect(transients).toHaveBeenCalledTimes(1)
    expect(teardown).not.toHaveBeenCalled()
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
  })

  it('writes the restored rollback position before the solve request reads it', () => {
    const rollbackAtSolve: (number | null)[] = []
    reSolve.mockImplementation(() => {
      rollbackAtSolve.push(useEditorState.getState().rollbackPosition)
    })
    const { result } = renderDoc()
    openSketch(result)
    act(() => { result.current.handleMutation(addPoint()) })

    act(() => { result.current.handleUndo() })

    // The last request is the move's re-solve; reSolve reads the store live, so
    // the bar it sees is the one the adapter just derived, never the pre-undo
    // doc's position or the end of the restored stack.
    expect(rollbackAtSolve.at(-1)).toBe(2)
  })

  it('a move with no session still hands back to the full teardown', () => {
    const { result, teardown, transients } = renderDoc()
    act(() => { result.current.handleMutation(addPoint()) })

    act(() => { result.current.handleUndo() })

    expect(teardown).toHaveBeenCalledTimes(1)
    expect(transients).not.toHaveBeenCalled()
    expect(useEditorState.getState().editingFeatureId).toBeNull()
  })
})
