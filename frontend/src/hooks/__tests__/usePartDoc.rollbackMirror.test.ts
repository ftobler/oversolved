import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePartDoc } from '@/hooks/usePartDoc'
import { usePartEditorStore } from '@/stores/partEditorStore'
import type { PartDoc } from '@/types/cad'

const docRef: { current: PartDoc | null } = { current: null }

vi.mock('@/hooks/useDocumentState', () => ({
  useDocumentState: () => ({
    doc: docRef.current,
    setDoc: vi.fn(),
    docRef,
    docName: 'test',
    setDocName: vi.fn(),
    ownerUsername: null,
    loading: false,
    error: null,
    setError: vi.fn(),
    saveDoc: vi.fn(),
    renameDoc: vi.fn(),
  }),
  BUILTIN_FEATURE_DEFAULTS: [],
  BUILTIN_FEATURE_IDS: new Set<string>(),
}))

vi.mock('@/hooks/useSolver', () => ({
  useSolver: () => ({
    solveResults: {},
    setSolveResults: vi.fn(),
    bodies: {},
    pickBodies: {},
    solving: false,
    solveError: null,
    setSolveError: vi.fn(),
    solveResult: null,
    featureTimings: {},
    reSolve: vi.fn(),
    validation: null,
  }),
}))

vi.mock('@/hooks/useUndoRedo', () => ({
  useUndoRedo: () => ({
    undoStack: [],
    redoStack: [],
    suppressUndoRef: { current: false },
    pushUndo: vi.fn(),
    handleUndo: vi.fn(),
    handleRedo: vi.fn(),
    saveUndoStackSnapshot: vi.fn(),
    restoreUndoStackSnapshot: vi.fn(),
    clearUndoStackSnapshot: vi.fn(),
  }),
}))

function setDoc(doc: PartDoc) {
  docRef.current = doc
}

function makeDoc(rollback?: number): PartDoc {
  const doc: PartDoc = {
    version: 1,
    kind: 'part',
    features: [
      { id: 'sk1', kind: 'sketch' },
      { id: 'ex1', kind: 'extrude' },
      { id: 'ex2', kind: 'extrude' },
    ],
  }
  if (rollback !== undefined) doc.rollback = rollback
  return doc
}

function renderPartDoc() {
  return renderHook(() => usePartDoc('test-uuid', 'feature', vi.fn(), { solveOnLoad: false }))
}

describe('doc.rollback mirrors the rollback bar', () => {
  beforeEach(() => {
    usePartEditorStore.setState({ rollbackPosition: null, editingFeatureId: null, pickBoundary: null })
  })

  it('writes the parked position into the doc on a set_rollback mutation', () => {
    setDoc(makeDoc())
    usePartEditorStore.getState().setRollbackPosition(2)
    const { result } = renderPartDoc()

    act(() => { result.current.handleMutation({ type: 'set_rollback', position: 2 }) })

    expect(docRef.current!.rollback).toBe(2)
  })

  it('clears the doc position when the bar returns to the end of the stack', () => {
    setDoc(makeDoc(2))
    usePartEditorStore.getState().setRollbackPosition(3)
    const { result } = renderPartDoc()

    act(() => { result.current.handleMutation({ type: 'set_rollback', position: 3 }) })

    expect('rollback' in docRef.current!).toBe(false)
  })

  it('carries the parked position through an unrelated mutation', () => {
    setDoc(makeDoc(2))
    usePartEditorStore.getState().setRollbackPosition(2)
    const { result } = renderPartDoc()

    act(() => { result.current.handleMutation({ type: 'rename_feature', featureId: 'sk1', label: 'renamed' }) })

    expect(docRef.current!.rollback).toBe(2)
  })

  it('drops a stale position when a feature is appended past the bar', () => {
    // Adding a feature moves the bar to the end of the (longer) stack. Were the
    // old position left in the doc, reopening it would hide the new feature.
    setDoc(makeDoc(2))
    usePartEditorStore.getState().setRollbackPosition(4)  // setRollbackForNewFeature: features.length + 1
    const { result } = renderPartDoc()

    act(() => { result.current.handleMutation({ type: 'add_sketch', featureId: 'sk2' }) })

    expect(docRef.current!.features).toHaveLength(4)
    expect('rollback' in docRef.current!).toBe(false)
  })

  it('leaves the doc position alone while a feature is being edited', () => {
    // Entering an edit pins the bar just after the edited feature; that position
    // is transient UI state and must not overwrite what the user parked.
    setDoc(makeDoc(2))
    const store = usePartEditorStore.getState()
    store.setRollbackPosition(1)
    store.setEditingFeatureId('sk1')
    const { result } = renderPartDoc()

    act(() => { result.current.handleMutation({ type: 'rename_feature', featureId: 'sk1', label: 'renamed' }) })

    expect(docRef.current!.rollback).toBe(2)
  })
})
