import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'
import { usePartEditorStore } from '@/stores/partEditorStore'
import type { PartDoc, Mutation } from '@/types/cad'

// failLoud throws in test mode, so a throwing assertion alone cannot tell the
// pre-fix code from the fix: both stop at the throw before ever reaching the
// snapshot-overwrite line. Production is the one environment where the two
// diverge (failLoud only warns), so this file mocks it to a no-op to exercise
// that path directly -- see usePartDoc.editSessionGuard.test.ts for the
// dev/test throwing behavior, which is unaffected by this change.
vi.mock('@/stores/stateInvariants', () => ({
  failLoud: vi.fn(),
}))

const makeDoc = (): PartDoc => ({
  oversolved: 1,
  kind: 'part',
  features: [{ id: 'extrude-1', kind: 'extrude', label: 'first' }],
} as unknown as PartDoc)

const docRef = { current: makeDoc() }
const reSolve = vi.fn()

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

describe('usePartDoc nested edit session guard (prod: failLoud warns, does not throw)', () => {
  beforeEach(() => {
    docRef.current = makeDoc()
    reSolve.mockClear()
    usePartEditorStore.getState().setEditingFeatureId(null)
    usePartEditorStore.getState().setRollbackPosition(null)
  })

  it('a nested startEditSession call does not overwrite the outer snapshot', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation(renameTo('a')) })

    // This is the real trigger from the plan: the plane-on-face effect firing
    // enterEditFeature again while the outer session is still open. Without
    // the guard's `return`, this call would clone the CURRENT (already-'a')
    // doc over editSnapshotRef.
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation(renameTo('b')) })

    act(() => { result.current.commitEditSession() })

    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.undoStack[0].mutation.type).toBe('edit_session')
    expect(labelOf()).toBe('b')

    // The aggregate's restore point must be the doc from BEFORE the first
    // startEditSession call ('first'), not the mid-session doc the nested
    // call would have overwritten it with ('a'). Landing on 'a' would mean
    // the edits made before the nested call became permanently non-undoable.
    act(() => { result.current.handleUndo() })
    expect(labelOf()).toBe('first')
  })
})
