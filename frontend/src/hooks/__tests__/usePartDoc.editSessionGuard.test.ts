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
    validation: null,
    clearValidation: vi.fn(),
  }),
}))

vi.mock('@/hooks/mutationDispatch', () => ({
  // The session's up-front boundary refuses an unknown type in every build,
  // so the preview fixture needs a handler even though this suite only checks
  // the session transaction guards.
  mutationHandlers: { set_part_color: () => {} },
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

  it('does not throw on startEditSession with a live preview (the preview is resolved first)', () => {
    const { result } = renderHook(() => usePartDoc('test-uuid', { solveOnLoad: false }))
    result.current.startPreviewMode({ features: [] } as never)
    result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' } as never)
    expect(() => result.current.startEditSession(true)).not.toThrow()
  })

  it('throws on startPreviewMode while an edit session is active', () => {
    const { result } = renderHook(() => usePartDoc('test-uuid', { solveOnLoad: false }))
    result.current.startEditSession(true)
    expect(() => result.current.startPreviewMode({ features: [] } as never))
      .toThrow('[usePartDoc] startPreviewMode called while an edit session is active')
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
