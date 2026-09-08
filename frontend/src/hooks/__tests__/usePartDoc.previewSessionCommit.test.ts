import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'
import { usePartEditorStore } from '@/stores/partEditorStore'
import type { PartDoc, Mutation } from '@/types/cad'

// failLoud throws in test mode, and commitEditSession's commitPreview on the
// post-fix path would have nothing left to fail loud about only after the
// boundary resolved the preview. The repro's point is the STACK order a stale
// key would corrupt, so this file mocks failLoud to a no-op and asserts the
// resulting stacks directly -- see usePartDoc.startEditSessionPreviewProd.test.ts
// for the same rationale.
vi.mock('@/stores/stateInvariants', () => ({
  failLoud: vi.fn(),
}))

const makeDoc = (): PartDoc => ({
  oversolved: 1,
  kind: 'part',
  part_style: { b1: { color: '#ff0000' } },
  features: [{ id: 'extrude-1', kind: 'extrude', label: 'first' }],
} as unknown as PartDoc)

const docRef: { current: PartDoc | null } = { current: makeDoc() }
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

const labelOf = () => (docRef.current?.features?.[0] as { label?: string } | undefined)?.label
const colorOf = () => (docRef.current?.part_style?.b1 as { color?: string } | undefined)?.color

const openPreviewAndSwallowColor = (result: { current: { startPreviewMode: (d: PartDoc) => void; handleMutation: (m: Mutation) => void } }) => {
  act(() => { result.current.startPreviewMode(structuredClone(docRef.current!)) })
  act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })
}

describe('usePartDoc preview at the sketch-session commit boundary', () => {
  beforeEach(() => {
    docRef.current = makeDoc()
    reSolve.mockClear()
    usePartEditorStore.getState().setEditingFeatureId(null)
    usePartEditorStore.getState().setRollbackPosition(null)
  })

  it('a sketch session commit resolves an open preview, so a later Apply cannot key a stale preview_commit', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(false) })  // sketch: not suppressed
    act(() => { result.current.handleMutation(renameTo('a')) })  // per-action entry
    // The color popover opens mid-session and swallows one slider frame.
    act(() => { result.current.startPreviewMode(structuredClone(docRef.current!)) })
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })
    expect(result.current.undoStack).toHaveLength(1)

    // OK on the feature edit fires with the popover still open (Apply never
    // clicked): the sketch boundary must resolve the preview just like a
    // suppressed one, keyed to the pre-preview doc.
    act(() => { result.current.commitEditSession() })
    expect(result.current.undoStack).toHaveLength(2)
    expect(result.current.undoStack[0].mutation.type).toBe('rename_feature')
    expect(result.current.undoStack[1].mutation.type).toBe('preview_commit')
    expect((result.current.undoStack[1].doc.part_style?.b1 as { color?: string }).color).toBe('#ff0000')
    expect(colorOf()).toBe('#00ff00')

    // A later drag while the popover is still visually open is now a plain live
    // edit pushed as its own entry.
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#0000ff' }) })
    expect(result.current.undoStack).toHaveLength(3)
    expect(result.current.undoStack[2].mutation.type).toBe('set_part_color')
    expect((result.current.undoStack[2].doc.part_style?.b1 as { color?: string }).color).toBe('#00ff00')

    // The popover's own Apply after the boundary has no preview to key against:
    // it must be inert instead of pushing preview_commit keyed to the stale
    // pre-preview doc that predates the live edit.
    act(() => { result.current.commitPreview({ type: 'set_part_color', bodyId: 'b1', color: '#0000ff' }) })
    expect(result.current.undoStack).toHaveLength(3)

    // Undo pops the color first (the live edit was applied last), then the
    // preview_commit's pre-preview doc, then the session's rename. The swallowed
    // '#00ff00' frame must never re-surface as its own undo step.
    act(() => { result.current.handleUndo() })
    expect(colorOf()).toBe('#00ff00')
    act(() => { result.current.handleUndo() })
    expect(colorOf()).toBe('#ff0000')
    act(() => { result.current.handleUndo() })
    expect(labelOf()).toBe('first')
    expect(colorOf()).toBe('#ff0000')
  })

  it('a sketch session commit leaves no previewOriginalDoc behind and clears suppression', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(false) })
    openPreviewAndSwallowColor(result)

    act(() => { result.current.commitEditSession() })

    // The invariant now holds for both session kinds: no preview survives the
    // boundary, so the popover's own Cancel is an inert null no-op.
    let cancelled: PartDoc | null = null
    act(() => { cancelled = result.current.cancelPreview() })
    expect(cancelled).toBeNull()

    // And suppression is off: the next edit pushes normally instead of vanishing.
    act(() => { result.current.handleMutation(renameTo('after')) })
    expect(result.current.undoStack).toHaveLength(2)
    expect(result.current.undoStack[1].mutation.type).toBe('rename_feature')
  })

  it('a sketch session commit with no preview open pushes nothing extra', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(false) })
    act(() => { result.current.handleMutation(renameTo('a')) })
    act(() => { result.current.commitEditSession() })

    // Exactly the one per-action entry: no phantom preview_commit, no aggregate.
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.undoStack[0].mutation.type).toBe('rename_feature')
  })

  it('a suppressed session commit with an open preview keeps the [preview_commit, edit_session] order', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation(renameTo('a')) })
    openPreviewAndSwallowColor(result)

    act(() => { result.current.commitEditSession() })

    // The aggregate edit_session is pushed first, then the preview_commit on
    // top: the color was the last interaction, so its undo comes first and must
    // not resurrect the swallowed edits on the second undo.
    expect(result.current.undoStack).toHaveLength(2)
    expect(result.current.undoStack[0].mutation.type).toBe('edit_session')
    expect(result.current.undoStack[1].mutation.type).toBe('preview_commit')
  })

  it('cancelling a sketch session with an open preview drops the refs so the later Cancel is inert', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(false) })
    openPreviewAndSwallowColor(result)

    act(() => { result.current.cancelEditSession() })

    // The session rewind discards the preview color with the session; the
    // popover's own Cancel afterward finds nothing left to rewind.
    expect(colorOf()).toBe('#ff0000')
    expect(result.current.undoStack).toHaveLength(0)
    let cancelled: PartDoc | null = null
    act(() => { cancelled = result.current.cancelPreview() })
    expect(cancelled).toBeNull()
  })
})
