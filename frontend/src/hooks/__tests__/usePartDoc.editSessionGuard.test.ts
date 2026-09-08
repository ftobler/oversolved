import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { usePartDoc } from '@/hooks/usePartDoc'

// Mock the heavy dependencies
vi.mock('@/hooks/useDocumentState', () => ({
  useDocumentState: () => ({
    doc: null,
    setDoc: vi.fn(),
    docRef: { current: { features: [] } },
    docName: 'test',
    setDocName: vi.fn(),
    ownerUsername: null,
    loading: false,
    error: null,
    setError: vi.fn(),
    saveDoc: vi.fn(),
    renameDoc: vi.fn(),
  }),
  BUILTIN_FEATURE_DEFAULTS: {},
  BUILTIN_FEATURE_IDS: new Set<string>(),
}))

vi.mock('@/hooks/useSolver', () => ({
  useSolver: () => ({
    solveResults: {},
    setSolveResults: vi.fn(),
    bodies: {},
    pickBodies: {},
    solving: false,
    solveTime: 0,
    solveError: null,
    setSolveError: vi.fn(),
    solveResult: null,
    featureTimings: {},
    reSolve: vi.fn(),
    setRollbackPos: vi.fn(),
    setPickBoundary: vi.fn(),
    validation: null,
    clearValidation: vi.fn(),
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

vi.mock('@/hooks/mutationDispatch', () => ({
  mutationHandlers: {},
}))

describe('usePartDoc edit session guards', () => {
  it('throws on nested startEditSession', () => {
    const { result } = renderHook(() => usePartDoc('test-uuid', { solveOnLoad: false }))
    result.current.startEditSession(true)
    expect(() => result.current.startEditSession(true)).toThrow('[usePartDoc] startEditSession called while an edit session is already active')
  })

  it('does not throw on commitEditSession without start', () => {
    const { result } = renderHook(() => usePartDoc('test-uuid', { solveOnLoad: false }))
    expect(() => result.current.commitEditSession()).not.toThrow()
  })

  it('does not throw on cancelEditSession without start', () => {
    const { result } = renderHook(() => usePartDoc('test-uuid', { solveOnLoad: false }))
    expect(() => result.current.cancelEditSession()).not.toThrow()
  })

  it('throws on nested startPreviewMode', () => {
    const { result } = renderHook(() => usePartDoc('test-uuid', { solveOnLoad: false }))
    result.current.startPreviewMode({ features: [] } as never)
    expect(() => result.current.startPreviewMode({ features: [] } as never)).toThrow('[usePartDoc] startPreviewMode called while a preview is already active')
  })

  it('throws on startEditSession with a live preview (half-open session start)', () => {
    const { result } = renderHook(() => usePartDoc('test-uuid', { solveOnLoad: false }))
    result.current.startPreviewMode({ features: [] } as never)
    result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' } as never)
    expect(() => result.current.startEditSession(true)).toThrow('[usePartDoc] startEditSession called while a preview is active')
  })

  it('throws on commitPreview without start', () => {
    const { result } = renderHook(() => usePartDoc('test-uuid', { solveOnLoad: false }))
    expect(() => result.current.commitPreview({ type: 'test' } as never)).toThrow('[usePartDoc] commitPreview called with no active preview')
  })

  it('does not throw on start+commit sequence', () => {
    const { result } = renderHook(() => usePartDoc('test-uuid', { solveOnLoad: false }))
    result.current.startEditSession(true)
    expect(() => result.current.commitEditSession()).not.toThrow()
  })

  it('does not throw on start+cancel sequence', () => {
    const { result } = renderHook(() => usePartDoc('test-uuid', { solveOnLoad: false }))
    result.current.startEditSession(true)
    expect(() => result.current.cancelEditSession()).not.toThrow()
  })
})
