// The IDEMPOTENT_MUTATION_TYPES no-op guard in handleMutation: a dispatch that
// leaves the doc byte-identical must push no undo entry, set no dirty flag and
// waste no re-solve. This pins the guard for set_rollback (a same-position
// drag) and the remove_* family (a stale out-of-range index), and confirms the
// add_* toggle family stays unguarded (a re-add is a real toggle change).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import type { PartDoc, Mutation } from '@/types/cad'

const docRef: { current: PartDoc | null } = { current: null }
const reSolve = vi.fn()
const pushUndo = vi.fn()

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
    cloneDoc: vi.fn(),
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
    reSolve,
    validation: null,
  }),
}))

vi.mock('@/hooks/useUndoRedo', () => ({
  useUndoRedo: () => ({
    undoStack: [],
    redoStack: [],
    suppressUndoRef: { current: false },
    pushUndo,
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
  return renderHookStrict(() => usePartDoc('test-uuid', 'feature', vi.fn(), { solveOnLoad: false }))
}

// One doc per remove_* handler, each with a list long enough that a valid index
// differs from the out-of-range one the guard is exercised with.
const REMOVE_CASES: { name: string; makeDoc: () => PartDoc; mutation: Mutation }[] = [
  {
    name: 'remove_extrude_profile',
    makeDoc: () => ({ version: 1, kind: 'part', features: [{ id: 'ex1', kind: 'extrude', extrude: { sketch: ['@sk1', '@sk2'], distance: 10, direction: 'normal' } }] }) as unknown as PartDoc,
    mutation: { type: 'remove_extrude_profile', featureId: 'ex1', index: 9 },
  },
  {
    name: 'remove_revolve_profile',
    makeDoc: () => ({ version: 1, kind: 'part', features: [{ id: 'rv1', kind: 'revolve', revolve: { sketch: ['@sk1'], angle: 360, axis_origin: [0, 0, 0], axis_direction: [0, 0, 1] } }] }) as unknown as PartDoc,
    mutation: { type: 'remove_revolve_profile', featureId: 'rv1', index: 9 },
  },
  {
    name: 'remove_sweep_profile',
    makeDoc: () => ({ version: 1, kind: 'part', features: [{ id: 'sw1', kind: 'sweep', sweep: { sketch: ['@sk1'], path: ['@p1'] } }] }) as unknown as PartDoc,
    mutation: { type: 'remove_sweep_profile', featureId: 'sw1', index: 9 },
  },
  {
    name: 'remove_sweep_path',
    makeDoc: () => ({ version: 1, kind: 'part', features: [{ id: 'sw1', kind: 'sweep', sweep: { sketch: ['@sk1'], path: ['@p1'] } }] }) as unknown as PartDoc,
    mutation: { type: 'remove_sweep_path', featureId: 'sw1', index: 9 },
  },
  {
    name: 'remove_fillet_edge',
    makeDoc: () => ({ version: 1, kind: 'part', features: [{ id: 'f1', kind: 'fillet', fillet: { edges: ['?e1', '?e2'], radius: 1 } }] }) as unknown as PartDoc,
    mutation: { type: 'remove_fillet_edge', featureId: 'f1', index: 9 },
  },
  {
    name: 'remove_chamfer_edge',
    makeDoc: () => ({ version: 1, kind: 'part', features: [{ id: 'ch1', kind: 'chamfer', chamfer: { edges: ['?e1'], distance: 1, kind: 'distance', angle: 45 } }] }) as unknown as PartDoc,
    mutation: { type: 'remove_chamfer_edge', featureId: 'ch1', index: 9 },
  },
  {
    name: 'remove_delete_body_ref',
    makeDoc: () => ({ version: 1, kind: 'part', features: [{ id: 'db1', kind: 'delete_body', delete_body: { bodies: ['@b1', '@b2'] } }] }) as unknown as PartDoc,
    mutation: { type: 'remove_delete_body_ref', featureId: 'db1', index: 9 },
  },
  {
    name: 'remove_transform_body',
    makeDoc: () => ({ version: 1, kind: 'part', features: [{ id: 't1', kind: 'transform', transform: { bodies: ['@b1', '@b2'], operation: 'new', translation: [0, 0, 0], rotation_angle: 0, scale: 1 } }] }) as unknown as PartDoc,
    mutation: { type: 'remove_transform_body', featureId: 't1', index: 9 },
  },
  {
    name: 'remove_boolean_tool (tool not listed)',
    makeDoc: () => ({ version: 1, kind: 'part', features: [{ id: 'b1', kind: 'boolean', boolean: { operation: 'union', target: '', tools: ['@t1'] } }] }) as unknown as PartDoc,
    mutation: { type: 'remove_boolean_tool', featureId: 'b1', tool: '@missing' },
  },
]

describe('idempotent no-op guard', () => {
  beforeEach(() => {
    docRef.current = null
    reSolve.mockClear()
    pushUndo.mockClear()
    usePartEditorStore.setState({ rollbackPosition: null, editingFeatureId: null, pickBoundary: null })
    useUnsavedChangesStore.getState().setDirty(false)
  })

  it('set_rollback to the doc position already parked pushes nothing and stays clean', () => {
    setDoc(makeDoc(2))
    usePartEditorStore.getState().setRollbackPosition(2)
    const { result } = renderPartDoc()

    act(() => { result.current.handleMutation({ type: 'set_rollback', position: 2 }) })

    expect(pushUndo).not.toHaveBeenCalled()
    expect(reSolve).not.toHaveBeenCalled()
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
    expect(docRef.current!.rollback).toBe(2)
  })

  it('set_rollback to the end when the key is absent is a no-op', () => {
    setDoc(makeDoc())
    usePartEditorStore.getState().setRollbackPosition(3)
    const { result } = renderPartDoc()

    act(() => { result.current.handleMutation({ type: 'set_rollback', position: 3 }) })

    expect(pushUndo).not.toHaveBeenCalled()
    expect(reSolve).not.toHaveBeenCalled()
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
    expect('rollback' in docRef.current!).toBe(false)
  })

  it('set_rollback to a NEW position pushes an entry, updates the doc and re-solves', () => {
    setDoc(makeDoc(2))
    usePartEditorStore.getState().setRollbackPosition(1)
    const { result } = renderPartDoc()

    act(() => { result.current.handleMutation({ type: 'set_rollback', position: 1 }) })

    expect(pushUndo).toHaveBeenCalledTimes(1)
    expect(docRef.current!.rollback).toBe(1)
    expect(reSolve).toHaveBeenCalledTimes(1)
  })

  describe.each(REMOVE_CASES)('$name with an out-of-range index', ({ makeDoc, mutation }) => {
    it('pushes nothing and does not re-solve', () => {
      setDoc(makeDoc())
      const { result } = renderPartDoc()
      const before = JSON.stringify(docRef.current)

      act(() => { result.current.handleMutation(mutation) })

      expect(JSON.stringify(docRef.current)).toBe(before)
      expect(pushUndo).not.toHaveBeenCalled()
      expect(reSolve).not.toHaveBeenCalled()
      expect(useUnsavedChangesStore.getState().dirty).toBe(false)
    })
  })

  it('a real remove at a valid index still pushes and re-solves', () => {
    setDoc({ version: 1, kind: 'part', features: [{ id: 'ex1', kind: 'extrude', extrude: { sketch: ['@sk1', '@sk2'], distance: 10, direction: 'normal' } }] } as unknown as PartDoc)
    const { result } = renderPartDoc()

    act(() => { result.current.handleMutation({ type: 'remove_extrude_profile', featureId: 'ex1', index: 0 }) })

    expect(pushUndo).toHaveBeenCalledTimes(1)
    expect(reSolve).toHaveBeenCalledTimes(1)
    expect((docRef.current!.features![0] as { extrude: { sketch: string[] } }).extrude.sketch).toEqual(['@sk2'])
  })

  it('re-adding an already-listed edge toggles it back out and still pushes', () => {
    setDoc({ version: 1, kind: 'part', features: [{ id: 'f1', kind: 'fillet', fillet: { edges: ['?e1', '?e2'], radius: 1 } }] } as unknown as PartDoc)
    const { result } = renderPartDoc()

    act(() => { result.current.handleMutation({ type: 'add_fillet_edge', featureId: 'f1', edgeQuery: '?e1' }) })

    expect(pushUndo).toHaveBeenCalledTimes(1)
    expect(reSolve).toHaveBeenCalledTimes(1)
    expect((docRef.current!.features![0] as { fillet: { edges: string[] } }).fillet.edges).toEqual(['?e2'])
  })
})
