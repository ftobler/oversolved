import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import type { PartDoc } from '@/types/cad'
import { docRef, renameTo, resetHarness } from './usePartDoc.undoHarness'

vi.mock('@/hooks/useDocumentState', async () => {
  const { documentStateMock } = await import('./usePartDoc.undoHarness')
  return documentStateMock()
})

vi.mock('@/hooks/useSolver', async () => {
  const { solverMock } = await import('./usePartDoc.undoHarness')
  return solverMock()
})

const dirty = () => useUnsavedChangesStore.getState().dirty

// A cancel rewinds the doc to the moment its session or preview opened, so the
// unsaved-changes flag goes back with it; the assembly cancelSession already
// did this, the part editor left the flag set.
describe('usePartDoc cancel restores the unsaved-changes flag', () => {
  beforeEach(() => {
    resetHarness()
    useUnsavedChangesStore.getState().setDirty(false)
  })

  it('cancelling an edit session on a clean doc leaves it clean', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation(renameTo('discarded')) })
    expect(dirty()).toBe(true)

    act(() => { result.current.cancelEditSession() })
    expect(dirty()).toBe(false)
  })

  it('cancelling an edit session opened on a dirty doc keeps it dirty', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('kept')) })
    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation(renameTo('discarded')) })

    act(() => { result.current.cancelEditSession() })
    expect(dirty()).toBe(true)
  })

  // The save stored the session's edits; the rewind throws them away, so the
  // live doc no longer matches what is saved even though it was clean at entry.
  it('a save mid-session leaves the cancelled doc dirty', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation(renameTo('saved-then-discarded')) })
    useUnsavedChangesStore.getState().markSaved()  // the save landing

    act(() => { result.current.cancelEditSession() })
    expect(dirty()).toBe(true)
  })

  // The flag alone cannot tell this from "never saved": the edit after the save
  // set it again, so only the save count says the stored bytes hold the edits.
  it('a save followed by another edit mid-session still leaves the cancelled doc dirty', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation(renameTo('saved')) })
    useUnsavedChangesStore.getState().markSaved()
    act(() => { result.current.handleMutation(renameTo('edited-after-save')) })
    expect(dirty()).toBe(true)

    act(() => { result.current.cancelEditSession() })
    expect(dirty()).toBe(true)
  })

  it('cancelling a color preview on a clean doc leaves it clean', () => {
    docRef.current = {
      version: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })
    expect(dirty()).toBe(true)

    act(() => { result.current.cancelPreview() })
    expect(dirty()).toBe(false)
  })
})
