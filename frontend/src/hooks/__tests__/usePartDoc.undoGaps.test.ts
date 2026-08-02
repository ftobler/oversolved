// The dead-entry and invalidation branches of the part undo funnel that the
// main undoIntegration suite does not cover: commitMutationGroup no-op / empty
// / suppressed groups, the code-tab doc swap (discardHistoryAndSessions), the
// null-docRef early return, the preview label fallback and redo's dirty flag.
// Mirrors the undoIntegration harness: real useUndoRedo, real handlers.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import type { PartDoc, Mutation } from '@/types/cad'

const makeDoc = (): PartDoc => ({
  oversolved: 1,
  kind: 'part',
  features: [{ id: 'extrude-1', kind: 'extrude', label: 'first' }],
} as unknown as PartDoc)

const makeSketchDoc = (): PartDoc => ({
  oversolved: 1,
  kind: 'part',
  features: [{ id: 'sk1', kind: 'sketch' }],
} as unknown as PartDoc)

const docRef: { current: PartDoc | null } = { current: makeDoc() }
const reSolve = vi.fn()

vi.mock('@/hooks/useDocumentState', () => ({
  useDocumentState: () => ({
    doc: docRef.current, docRef, docName: 'test', setDocName: vi.fn(),
    setDoc: (d: PartDoc) => { docRef.current = d },
    ownerUsername: null, loading: false, error: null, setError: vi.fn(),
    saveDoc: vi.fn(), renameDoc: vi.fn(), cloneDoc: vi.fn(),
    permission: 'owner', isCloudDoc: false,
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

const labelOf = () => (docRef.current?.features?.[0] as { label?: string } | undefined)?.label

const sketchEntitiesOf = (): { id: string }[] =>
  (docRef.current?.features?.[0] as { entities?: { id: string }[] } | undefined)?.entities ?? []

describe('usePartDoc undo edge cases', () => {
  beforeEach(() => {
    docRef.current = makeDoc()
    reSolve.mockClear()
    usePartEditorStore.getState().setEditingFeatureId(null)
    usePartEditorStore.getState().setRollbackPosition(null)
    useUnsavedChangesStore.getState().setDirty(false)
  })

  it('a no-op mutation group pushes nothing and neither dirties nor re-solves', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    // A re-dropped selection whose handlers all no-op (rename to the current
    // label) must not leave a dead entry or waste a solve, mirroring the
    // single-mutation no-op guard.
    act(() => { result.current.commitMutationGroup([renameTo('first')]) })

    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(0)
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
    expect(reSolve).not.toHaveBeenCalled()
    expect(labelOf()).toBe('first')
  })

  it('an empty mutation group is a harmless no-op', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    expect(() => {
      act(() => { result.current.commitMutationGroup([]) })
    }).not.toThrow()

    expect(result.current.undoStack).toHaveLength(0)
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
    expect(reSolve).not.toHaveBeenCalled()
  })

  it('a mutation group inside a suppressed session pushes no dead entry', () => {
    docRef.current = makeSketchDoc()
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))
    usePartEditorStore.getState().setEditingFeatureId('sk1')
    act(() => { result.current.startEditSession(true) })

    act(() => {
      result.current.commitMutationGroup([
        { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 0, 5, 5], entityId: 'l2' },
      ] as Mutation[])
    })

    // The session swallows the group: no per-action entry, but the doc changed
    // and the solve ran, so the session commit folds exactly one aggregate.
    expect(result.current.undoStack).toHaveLength(0)
    expect(sketchEntitiesOf().some(e => e.id === 'l2')).toBe(true)

    act(() => { result.current.commitEditSession() })
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.undoStack[0].mutation.type).toBe('edit_session')
  })

  it('discardHistoryAndSessions clears the stacks and leaves a post-swap cancel inert', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('a')) })
    expect(result.current.undoStack).toHaveLength(1)

    // The code tab swaps the document in while an edit session is open; the
    // session parked a stack snapshot on start.
    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation(renameTo('in-edit')) })

    act(() => { result.current.discardHistoryAndSessions() })

    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(0)

    // The cancelled session must not resurrect the history the code tab just
    // dropped: restoreUndoStackSnapshot (via cancelEditSession) is inert.
    act(() => { result.current.cancelEditSession() })
    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(0)
  })

  it('handleMutation with a null docRef is a no-op that pushes nothing', () => {
    docRef.current = null
    reSolve.mockClear()
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    expect(() => {
      act(() => { result.current.handleMutation(renameTo('x')) })
    }).not.toThrow()

    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(0)
    expect(reSolve).not.toHaveBeenCalled()
  })

  it('a preview commit whose change is outside part_style keeps the passed mutation as the label', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))
    const prePreview = structuredClone(docRef.current!)

    act(() => { result.current.startPreviewMode(prePreview) })
    // The doc changed outside part_style while the popover was open (its Apply
    // still passes set_part_color). With no part_style diff the composed label
    // is null, so commitPreview falls back to the mutation it was handed.
    docRef.current = {
      ...docRef.current,
      features: [{ id: 'extrude-1', kind: 'extrude', label: 'changed' }],
    } as unknown as PartDoc
    act(() => { result.current.commitPreview({ type: 'set_part_color', bodyId: 'b1', color: '#ff0000' }) })

    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.undoStack[0].mutation.type).toBe('set_part_color')
    // The entry restores the pre-preview doc, not a fabricated preview_commit.
    expect((result.current.undoStack[0].doc.features?.[0] as { label?: string }).label).toBe('first')
  })

  it('a redo also marks the doc unsaved', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('a')) })
    act(() => { result.current.handleUndo() })
    expect(labelOf()).toBe('first')
    useUnsavedChangesStore.getState().setDirty(false)

    act(() => { result.current.handleRedo() })
    expect(labelOf()).toBe('a')
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
  })
})
