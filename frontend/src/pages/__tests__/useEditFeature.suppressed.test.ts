// @vitest-environment jsdom
//
// A suppressed feature has no solved geometry, so opening its editor would show
// the stored seed and misrepresent the document. The refusal lives at the one
// entry every edit gesture funnels through, not only on the disabled pencil.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useEditFeature } from '@/pages/useEditFeature'

import type { PartDoc, PartFeature } from '@/types/cad'
import type { Result } from '@/session/result'
import { useEditorState } from '@/hooks/useEditorState'

const FEATURES: PartFeature[] = [
  { id: 'sk1', kind: 'sketch', label: 'Sketch 1', suppressed: true },
  { id: 'ex1', kind: 'extrude', label: 'Extrude 1', suppressed: true, extrude: { sketch: [], distance: 1 } },
  { id: 'ex2', kind: 'extrude', label: 'Extrude 2', extrude: { sketch: [], distance: 1 } },
]

function setup() {
  const startEditSession = vi.fn()
  const requestSolve = vi.fn()
  const setMode = vi.fn(() => true)
  const { result } = renderHook(() => useEditFeature({
    features: FEATURES,
    builtInIds: new Set(),
    startEditSession,
    commitEditSession: vi.fn(),
    cancelEditSession: vi.fn(),
    docRef: { current: { features: FEATURES } as PartDoc },
    requestSolve,
    setMode,
  }))
  return { result, startEditSession, requestSolve, setMode }
}

describe('useEditFeature refuses a suppressed feature', () => {
  beforeEach(() => {
    useEditorState.setState({
    editingFeatureId: null,
    rollbackPosition: null,
    pickBoundary: null,
  })
  })

  it('refuses a suppressed sketch by its label and opens nothing', () => {
    const { result, startEditSession, requestSolve, setMode } = setup()

    const captured: { refusal?: Result } = {}
    act(() => { captured.refusal = result.current.enterEditSketch('sk1') })

    expect(captured.refusal).toMatchObject({ ok: false, code: 'refused' })
    const refusal = captured.refusal
    const message = refusal && !refusal.ok ? refusal.message : ''
    expect(message).toContain('Sketch 1')
    expect(message).not.toContain('sk1')
    expect(useEditorState.getState().editingFeatureId).toBeNull()
    expect(startEditSession).not.toHaveBeenCalled()
    expect(requestSolve).not.toHaveBeenCalled()
    // The panel must not flip to sketch mode for an editor that never opens.
    expect(setMode).not.toHaveBeenCalled()
  })

  it('refuses a suppressed solid feature through the feature entry too', () => {
    const { result, startEditSession } = setup()

    const captured: { refusal?: Result } = {}
    act(() => { captured.refusal = result.current.enterEditFeature('ex1') })

    expect(captured.refusal).toMatchObject({ ok: false, code: 'refused' })
    expect(useEditorState.getState().editingFeatureId).toBeNull()
    expect(startEditSession).not.toHaveBeenCalled()
  })

  it('still opens an unsuppressed feature', () => {
    const { result, startEditSession } = setup()

    const captured: { refusal?: Result } = {}
    act(() => { captured.refusal = result.current.enterEditFeature('ex2') })

    expect(captured.refusal).toBeUndefined()
    expect(useEditorState.getState().editingFeatureId).toBe('ex2')
    expect(startEditSession).toHaveBeenCalledTimes(1)
  })
})
