import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'
import { usePartEditorStore } from '@/stores/partEditorStore'
import type { PartDoc, Mutation } from '@/types/cad'

// failLoud throws in test mode, so startEditSession's half-open guard would
// abort at the throw and never reach the preview resolution the fix is about.
// Production is the one environment where the two diverge (failLoud only
// warns), so this file mocks it to a no-op to exercise the resolve path
// directly -- see usePartDoc.editSessionGuard.test.ts for the dev/test
// throwing behavior, which is unaffected by this change.
vi.mock('@/stores/stateInvariants', () => ({
  failLoud: vi.fn(),
}))

const makeDoc = (): PartDoc => ({
  oversolved: 1,
  kind: 'part',
  part_style: { b1: { color: '#ff0000' } },
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

const colorOf = () => (docRef.current.part_style?.b1 as { color?: string }).color

describe('usePartDoc startEditSession with an open preview (prod: failLoud warns, resolution still runs)', () => {
  beforeEach(() => {
    docRef.current = makeDoc()
    reSolve.mockClear()
    usePartEditorStore.getState().setEditingFeatureId(null)
    usePartEditorStore.getState().setRollbackPosition(null)
  })

  // Open a preview and swallow one color frame, the exact repro from the
  // review: the popover opened BEFORE the session start, its mutation applied
  // to the live doc with no undo entry yet.
  const openAndSwallowPreview = (result: { current: { startPreviewMode: (d: PartDoc) => void; handleMutation: (m: Mutation) => void } }) => {
    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })
  }

  it('a preview open at session start is resolved BEFORE the snapshot, so commit lands [preview_commit, edit_session]', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))
    openAndSwallowPreview(result)

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })

    // The preview was resolved at session START, not left dangling for the
    // commit boundary: the preview_commit is already on the stack and the
    // popover's own Cancel finds nothing left to rewind.
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.undoStack[0].mutation.type).toBe('preview_commit')
    let cancelled: PartDoc | null = null
    act(() => { cancelled = result.current.cancelPreview() })
    expect(cancelled).toBeNull()

    act(() => { result.current.handleMutation(renameTo('session-edit')) })
    act(() => { result.current.commitEditSession() })

    expect(result.current.undoStack).toHaveLength(2)
    expect(result.current.undoStack[0].mutation.type).toBe('preview_commit')
    expect(result.current.undoStack[1].mutation.type).toBe('edit_session')

    // First undo pops the gesture, keeping the color; the second pops the
    // preview_commit and restores the pre-preview color.
    act(() => { result.current.handleUndo() })
    expect(labelOf()).toBe('first')
    expect(colorOf()).toBe('#00ff00')
    act(() => { result.current.handleUndo() })
    expect(colorOf()).toBe('#ff0000')
  })

  it('cancelling a session with a pre-session preview keeps the color with its own preview_commit entry', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))
    openAndSwallowPreview(result)

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation(renameTo('discarded')) })
    act(() => { result.current.cancelEditSession() })

    // The snapshot was taken AFTER the preview resolution, so the rewind keeps
    // the preview color instead of baking the swallowed mutation into a doc
    // with no undo entry for it. The stack holds exactly one preview_commit
    // whose restore point is the pre-preview doc.
    expect(labelOf()).toBe('first')
    expect(colorOf()).toBe('#00ff00')
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.undoStack[0].mutation.type).toBe('preview_commit')
    expect((result.current.undoStack[0].doc.part_style?.b1 as { color?: string }).color).toBe('#ff0000')

    act(() => { result.current.handleUndo() })
    expect(colorOf()).toBe('#ff0000')
  })

  it('a non-suppressed (sketch) session start also resolves an open preview', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))
    openAndSwallowPreview(result)

    act(() => { result.current.startEditSession(false) })

    // Sketch sessions keep per-action entries, but the preview still resolves
    // at the boundary: the preview_commit is on the stack and the popover's
    // Cancel finds nothing to rewind.
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.undoStack[0].mutation.type).toBe('preview_commit')
    let cancelled: PartDoc | null = null
    act(() => { cancelled = result.current.cancelPreview() })
    expect(cancelled).toBeNull()

    act(() => { result.current.handleMutation(renameTo('a')) })
    act(() => { result.current.commitEditSession() })
    expect(result.current.undoStack).toHaveLength(2)
    expect(result.current.undoStack[1].mutation.type).toBe('rename_feature')
  })
})
