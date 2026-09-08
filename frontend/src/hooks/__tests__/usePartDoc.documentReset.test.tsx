import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { StrictMode, useEffect } from 'react'
import { render } from '@testing-library/react'
import { usePartDoc } from '@/hooks/usePartDoc'
import { usePartEditorStore } from '@/stores/partEditorStore'
import type { PartDoc, Mutation } from '@/types/cad'

// undo-document-reset: the undo stacks must not survive a document change.
// DocumentPage keys Part by uuid, so a route change is a full Part remount and
// a fresh useUndoRedo instance. These tests mount usePartDoc with a changing key
// to prove a remounted instance starts with empty stacks and no session state
// inherited from the previous document.

const makeDoc = (label: string): PartDoc => ({
  oversolved: 1,
  kind: 'part',
  features: [{ id: 'extrude-1', kind: 'extrude', label }],
} as unknown as PartDoc)

const docRef = { current: makeDoc('first') }
const reSolve = vi.fn()

// Static useDocumentState mock: it reads the module-level docRef, so the test
// simulates document B by swapping docRef before mounting the B instance. That
// is the plan's explicit design: the shared mock cannot load per-uuid, so B's
// doc is simulated directly.
vi.mock('@/hooks/useDocumentState', () => ({
  useDocumentState: () => ({
    doc: docRef.current, docRef, docName: 'test', setDocName: vi.fn(),
    setDoc: (d: PartDoc) => { docRef.current = d },
    ownerUsername: null, loading: false, error: null, setError: vi.fn(),
    saveDoc: vi.fn(), renameDoc: vi.fn(), cloneDoc: vi.fn(),
  }),
  BUILTIN_FEATURE_DEFAULTS: {},
  BUILTIN_FEATURE_IDS: new Set<string>(),
}))

vi.mock('@/hooks/useSolver', () => ({
  useSolver: () => ({
    solveResults: {}, setSolveResults: vi.fn(), bodies: {}, pickBodies: {},
    solving: false, solveError: null, setSolveError: vi.fn(), solveResult: null,
    featureTimings: {}, reSolve, validation: null,
  }),
}))

const renameTo = (label: string): Mutation =>
  ({ type: 'rename_feature', featureId: 'extrude-1', label }) as Mutation

const labelOf = () => (docRef.current.features?.[0] as { label?: string }).label

// The harness keys each instance by document, mirroring DocumentPage's
// <Part key={uuid} />. The hook result is captured in an effect (not during
// render) so the page-level test rules stay happy; the effect runs before any
// test reads it, because tests only read after act().
const harness = { latest: null as null | ReturnType<typeof usePartDoc> }
function Harness({ uuid }: { uuid: string }) {
  const result = usePartDoc(uuid, { solveOnLoad: false })
  useEffect(() => { harness.latest = result })
  return null
}

function mountDoc(key: string, uuid: string) {
  return render(<StrictMode><Harness key={key} uuid={uuid} /></StrictMode>)
}

describe('usePartDoc document reset via keyed remount', () => {
  beforeEach(() => {
    docRef.current = makeDoc('first')
    reSolve.mockClear()
    usePartEditorStore.getState().setEditingFeatureId(null)
    usePartEditorStore.getState().setRollbackPosition(null)
    usePartEditorStore.getState().setPickBoundary(null)
  })

  it('navigating to another document gives an empty undo stack and a no-op undo', () => {
    const view = mountDoc('A', 'A')
    act(() => { harness.latest!.handleMutation(renameTo('edited-A')) })
    expect(harness.latest!.undoStack).toHaveLength(1)

    view.unmount()
    docRef.current = makeDoc('first')  // B resolves its own content
    mountDoc('B', 'B')

    // The fresh instance must not inherit A's stack.
    expect(harness.latest!.undoStack).toHaveLength(0)
    expect(harness.latest!.redoStack).toHaveLength(0)

    act(() => { harness.latest!.handleUndo() })
    // No-op: nothing of A is restored into B's document.
    expect(labelOf()).toBe('first')
    expect(harness.latest!.undoStack).toHaveLength(0)
    expect(harness.latest!.redoStack).toHaveLength(0)
  })

  it('a clone of a document with an active edit session does not inherit suppressUndoRef', () => {
    const view = mountDoc('A', 'A')
    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { harness.latest!.startEditSession(true) })
    act(() => { harness.latest!.handleMutation(renameTo('in-edit')) })
    // The edit session suppresses pushes: while it is open, the mutation leaves
    // no entry (the "clone with an active edit session" premise).
    expect(harness.latest!.undoStack).toHaveLength(0)

    view.unmount()
    docRef.current = makeDoc('first')  // the clone's own fresh content
    mountDoc('B', 'B')

    // The new document must not inherit the source's suppression, or every
    // edit in the clone would silently skip the undo stack.
    act(() => { harness.latest!.handleMutation(renameTo('after')) })
    expect(harness.latest!.undoStack).toHaveLength(1)
    expect(labelOf()).toBe('after')
  })
})
