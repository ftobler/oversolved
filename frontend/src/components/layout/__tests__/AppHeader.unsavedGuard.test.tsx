import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import AppHeader from '../AppHeader'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'

function wrap() {
  return render(
    <BrowserRouter>
      <AppHeader title="Test" />
    </BrowserRouter>,
  )
}

describe('AppHeader unsaved-changes navigation guard', () => {
  beforeEach(() => {
    useUnsavedChangesStore.getState().setDirty(false)
    useUnsavedChangesStore.getState().dismissConfirm()
    window.history.pushState({}, '', '/workspaces/ws/entries/abc')
  })
  afterEach(() => {
    act(() => {
      useUnsavedChangesStore.getState().setDirty(false)
      useUnsavedChangesStore.getState().dismissConfirm()
    })
    vi.restoreAllMocks()
  })

  it('does not set a pending callback when there are no unsaved changes', () => {
    wrap()
    act(() => {
      fireEvent.click(screen.getByTitle('Workspaces'))
    })
    expect(useUnsavedChangesStore.getState().pendingCallback).toBeNull()
  })

  it('blocks navigation and stores a pending callback when dirty', () => {
    useUnsavedChangesStore.getState().setDirty(true)
    wrap()
    act(() => {
      fireEvent.click(screen.getByTitle('Workspaces'))
    })
    expect(useUnsavedChangesStore.getState().pendingCallback).not.toBeNull()
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
    // Pathname unchanged: navigation was blocked.
    expect(window.location.pathname).toBe('/workspaces/ws/entries/abc')
  })

  it('guard clears dirty after executing the stored callback', () => {
    useUnsavedChangesStore.getState().setDirty(true)
    wrap()
    act(() => {
      fireEvent.click(screen.getByTitle('Workspaces'))
    })
    expect(useUnsavedChangesStore.getState().pendingCallback).not.toBeNull()
    // Simulate the user confirming via the dialog.
    act(() => {
      useUnsavedChangesStore.getState().pendingCallback!()
      useUnsavedChangesStore.getState().dismissConfirm()
    })
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })

  // The header's Docs link leaves the editor the same way the burger does, so it
  // carries the same guard. Covered separately because it is the one remaining
  // header link that is not the burger, and losing its guard would be silent.
  it('guards the Docs link when dirty', () => {
    useUnsavedChangesStore.getState().setDirty(true)
    wrap()
    act(() => {
      fireEvent.click(screen.getByLabelText('Docs'))
    })
    expect(useUnsavedChangesStore.getState().pendingCallback).not.toBeNull()
    expect(window.location.pathname).toBe('/workspaces/ws/entries/abc')
  })
})
