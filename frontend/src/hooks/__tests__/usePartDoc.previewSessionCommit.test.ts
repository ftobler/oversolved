import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'
import { usePartEditorStore } from '@/stores/partEditorStore'
import type { PartDoc, Mutation } from '@/types/cad'

// A preview cannot open mid-session: startPreviewMode is refused. In prod that
// refusal is a silent no-op, so this file mocks failLoud to a no-op to exercise
// the prod path directly (the dev/test throw is pinned in
// usePartDoc.editSessionGuard.test.ts). A refused open leaves no preview, so
// the colour mutations below land as ordinary session edits.
vi.mock('@/stores/stateInvariants', () => ({
  failLoud: vi.fn(),
}))

const makeDoc = (): PartDoc => ({
  version: 1,
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
    loading: false, error: null, setError: vi.fn(),
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

describe('usePartDoc preview at the sketch-session commit boundary', () => {
  beforeEach(() => {
    docRef.current = makeDoc()
    reSolve.mockClear()
    usePartEditorStore.getState().setEditingFeatureId(null)
    usePartEditorStore.getState().setRollbackPosition(null)
  })

  it('colour edits mid sketch session are per-action entries and a later Apply is inert', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(false) })  // sketch: not suppressed
    act(() => { result.current.handleMutation(renameTo('a')) })  // per-action entry
    // The popover's open is refused mid-session (silent in prod), so the slider
    // frame is a plain sketch edit with its own per-action entry.
    act(() => { result.current.startPreviewMode(structuredClone(docRef.current!)) })
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })
    expect(result.current.undoStack).toHaveLength(2)
    expect(result.current.undoStack.map(e => e.mutation.type)).toEqual(['rename_feature', 'set_part_color'])

    // A sketch session commits no aggregate: the per-action entries are the
    // whole undo story.
    act(() => { result.current.commitEditSession() })
    expect(result.current.undoStack).toHaveLength(2)

    // The popover's own Apply after the refused open has no preview to key
    // against: it must be inert instead of pushing a preview_commit.
    act(() => { result.current.commitPreview({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })
    expect(result.current.undoStack).toHaveLength(2)

    // Undo pops the colour first (the later action), then the rename.
    act(() => { result.current.handleUndo() })
    expect(colorOf()).toBe('#ff0000')
    act(() => { result.current.handleUndo() })
    expect(labelOf()).toBe('first')
  })

  it('a refused mid-session preview leaves no cancel target and later edits push normally', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(false) })
    // The refused open is a silent no-op in prod; the colour lands as an
    // ordinary per-action sketch edit.
    act(() => { result.current.startPreviewMode(structuredClone(docRef.current!)) })
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })

    act(() => { result.current.commitEditSession() })

    // No preview survives the refused open, so the popover's own Cancel is an
    // inert null no-op.
    let cancelled: PartDoc | null = null
    act(() => { cancelled = result.current.cancelPreview() })
    expect(cancelled).toBeNull()

    // The session did not suppress: the next edit pushes normally.
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

  it('a suppressed session owns mid-session colour edits as one aggregate', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation(renameTo('a')) })
    // The popover cannot open over the session; its mutation is swallowed and
    // styleTouched folds it into the aggregate.
    act(() => { result.current.startPreviewMode(structuredClone(docRef.current!)) })
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })

    act(() => { result.current.commitEditSession() })

    // One aggregate for the whole session, no preview_commit beside it.
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.undoStack[0].mutation.type).toBe('edit_session')
    expect(colorOf()).toBe('#00ff00')

    act(() => { result.current.handleUndo() })
    expect(labelOf()).toBe('first')
    expect(colorOf()).toBe('#ff0000')
  })

  it('cancelling a sketch session with colour edits rewinds them and leaves Cancel inert', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(false) })
    act(() => { result.current.startPreviewMode(structuredClone(docRef.current!)) })
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })
    expect(result.current.undoStack).toHaveLength(1)

    act(() => { result.current.cancelEditSession() })

    // The session rewind discards the colour with the session and restores the
    // parked pre-session stacks; the popover's own Cancel afterward finds
    // nothing left to rewind.
    expect(colorOf()).toBe('#ff0000')
    expect(result.current.undoStack).toHaveLength(0)
    let cancelled: PartDoc | null = null
    act(() => { cancelled = result.current.cancelPreview() })
    expect(cancelled).toBeNull()
  })
})
