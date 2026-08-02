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

  it('a programmatic set_rollback without a pre-synced store fails loud', () => {
    setDoc(makeDoc())
    // The store keeps its default position while the payload claims 2: the only
    // writer of doc.rollback is the mirror, so the mutation would silently no-op
    // while still pushing an entry. The guard trips instead of swallowing it.
    usePartEditorStore.getState().setRollbackPosition(null)
    const { result } = renderPartDoc()

    expect(() => {
      act(() => { result.current.handleMutation({ type: 'set_rollback', position: 2 }) })
    }).toThrow('[usePartDoc] set_rollback dispatched with the rollback store not pre-synced')
  })

  it('a reorder leaves a parked rollback index pointing at the raw position', () => {
    // Rollback is a plain index into the feature list, deliberately not a
    // pointer that follows the reordered feature: the mirror rewrites
    // doc.rollback from the store's raw position, so after the reorder the bar
    // silently names a different feature. This pins the current semantics.
    setDoc({
      version: 1,
      kind: 'part',
      features: [
        { id: 'Origin', kind: 'origin' },
        { id: 'Top', kind: 'plane' },
        { id: 'Front', kind: 'plane' },
        { id: 'Right', kind: 'plane' },
        { id: 'A', kind: 'sketch' },
        { id: 'B', kind: 'extrude' },
        { id: 'C', kind: 'extrude' },
      ],
    } as PartDoc)
    usePartEditorStore.getState().setRollbackPosition(5)
    const { result } = renderPartDoc()

    act(() => { result.current.handleMutation({ type: 'reorder_features', featureId: 'C', toIndex: 4 }) })

    expect((docRef.current!.features ?? []).map(f => f.id)).toEqual(['Origin', 'Top', 'Front', 'Right', 'C', 'A', 'B'])
    expect(docRef.current!.rollback).toBe(5)
  })
})
