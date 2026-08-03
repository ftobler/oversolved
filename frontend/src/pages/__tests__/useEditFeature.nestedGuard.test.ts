import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useEditFeature } from '@/pages/useEditFeature'
import { usePartEditorStore } from '@/stores/partEditorStore'
import type { PartDoc, PartFeature } from '@/types/cad'

// Small unit-level companion to Part.nestedEditSessionGuard.test.tsx (which
// drives the guard through a full page render). Pins the guard's condition
// directly: re-entering the SAME feature that is already open must not run
// the close-then-reopen path. A guard written as `activeEditingId !== null`
// (forgetting the featureId comparison) would still pass every full-page test
// that only opens a DIFFERENT feature next -- this is the one that would
// catch it.
describe('useEditFeature nested-session guard (unit)', () => {
  beforeEach(() => {
    usePartEditorStore.setState({ editingFeatureId: null, rollbackPosition: null, pickBoundary: null })
  })

  it('re-entering the currently-open feature does not close and reopen it', () => {
    const features: PartFeature[] = [{ id: 'f1', kind: 'extrude' }]
    const commitEditSession = vi.fn()
    const { result } = renderHook(() => useEditFeature({
      features,
      builtInIds: new Set(),
      startEditSession: vi.fn(),
      commitEditSession,
      cancelEditSession: vi.fn(),
      docRef: { current: { features } as PartDoc },
      reSolve: vi.fn(),
      setMode: () => true,
    }))

    act(() => { result.current.enterEditFeature('f1') })
    expect(commitEditSession).not.toHaveBeenCalled()

    act(() => { result.current.enterEditFeature('f1') })
    expect(commitEditSession).not.toHaveBeenCalled()
  })
})
