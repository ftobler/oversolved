import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'

import type { PartDoc } from '@/types/cad'
import { useEditorState } from '@/hooks/useEditorState'

// A live docRef the tests mutate to stand in for edits made during a session.
const docRef = { current: { features: [] } as unknown as PartDoc }

vi.mock('@/hooks/useDocumentState', () => ({
  useDocumentState: () => ({
    doc: null, setDoc: vi.fn(), docRef, docName: 'test', setDocName: vi.fn(),
    loading: false, error: null, setError: vi.fn(),
    saveDoc: vi.fn(), renameDoc: vi.fn(),
  }),
  BUILTIN_FEATURE_DEFAULTS: {},
  BUILTIN_FEATURE_IDS: new Set<string>(),
}))

vi.mock('@/hooks/useSolver', () => ({
  useSolver: () => ({
    solveResults: {}, setSolveResults: vi.fn(), bodies: {}, pickBodies: {},
    solving: false, solveError: null, setSolveError: vi.fn(), solveResult: null,
    featureTimings: {}, reSolve: vi.fn(), validation: null,
  }),
}))

vi.mock('@/hooks/mutationDispatch', () => ({ mutationHandlers: {} }))

describe('commitEditSession undo entry', () => {
  beforeEach(() => {
    docRef.current = { features: [] } as unknown as PartDoc
    useEditorState.getState().setEditingFeatureId(null)
  })

  it('pushes no undo entry when the session changed nothing', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.commitEditSession() })
    expect(result.current.undoStack).toHaveLength(0)
  })

  it('pushes one undo entry naming the edited feature when the doc changed', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
    useEditorState.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    docRef.current = { features: [{ id: 'extrude-1' }] } as unknown as PartDoc
    act(() => { result.current.commitEditSession() })

    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.undoStack[0].mutation).toEqual({ type: 'edit_session', featureId: 'extrude-1' })
    // The entry restores the pre-session doc, not the post-session one.
    expect(result.current.undoStack[0].doc).toEqual({ features: [] })
  })

  // The solver fabricates part_style entries mid-session (reconcilePartStyle),
  // with no user mutation behind them. The session diff must exclude that key or
  // every solve would manufacture an edit entry that reverts nothing.
  it('pushes no undo entry when the doc differs only in a solve-fabricated part_style', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
    useEditorState.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    docRef.current = { features: [], part_style: { b1: { color: '#ff0000' } } } as unknown as PartDoc
    act(() => { result.current.commitEditSession() })

    expect(result.current.undoStack).toHaveLength(0)
  })

  // rollback is pinned during an edit (the mirror only runs outside one), so a
  // drift there is not a user change and must not leave a dead undo step.
  it('pushes no undo entry when the doc differs only in rollback', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
    useEditorState.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    docRef.current = { features: [], rollback: 2 } as unknown as PartDoc
    act(() => { result.current.commitEditSession() })

    expect(result.current.undoStack).toHaveLength(0)
  })

  // The complement of the two exclusions: a real feature change still earns the
  // aggregate, even when a fabricated part_style entry rides alongside it.
  it('pushes one entry when a feature change rides alongside fabricated part_style', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
    useEditorState.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    docRef.current = {
      features: [{ id: 'extrude-1' }],
      part_style: { b1: { color: '#ff0000' } },
    } as unknown as PartDoc
    act(() => { result.current.commitEditSession() })

    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.undoStack[0].mutation).toEqual({ type: 'edit_session', featureId: 'extrude-1' })
  })
})
