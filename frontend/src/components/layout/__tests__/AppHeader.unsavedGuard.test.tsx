import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Partial mock: the header pulls in the backend bundle (bug report sink), which
// reads `backend` too -- a bare { hasBackend } mock leaves that import undefined.
vi.mock('@/config/capabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/config/capabilities')>()),
  backend: 'http' as const,
  hasBackend: true,
  debugToolsUnrestricted: false,
}))

const mockUseAuth = vi.fn()
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

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
    mockUseAuth.mockReturnValue({ user: null, online: true, logout: vi.fn() })
    useUnsavedChangesStore.getState().setDirty(false)
    useUnsavedChangesStore.getState().dismissConfirm()
    window.history.pushState({}, '', '/documents/abc')
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
      fireEvent.click(screen.getByTitle('Documentation'))
    })
    expect(useUnsavedChangesStore.getState().pendingCallback).toBeNull()
  })

  it('blocks navigation and stores a pending callback when dirty', () => {
    useUnsavedChangesStore.getState().setDirty(true)
    wrap()
    act(() => {
      fireEvent.click(screen.getByTitle('Documentation'))
    })
    expect(useUnsavedChangesStore.getState().pendingCallback).not.toBeNull()
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
    // Pathname unchanged: navigation was blocked.
    expect(window.location.pathname).toBe('/documents/abc')
  })

  it('guard clears dirty after executing the stored callback', () => {
    useUnsavedChangesStore.getState().setDirty(true)
    wrap()
    act(() => {
      fireEvent.click(screen.getByTitle('Documentation'))
    })
    expect(useUnsavedChangesStore.getState().pendingCallback).not.toBeNull()
    // Simulate the user confirming via the dialog.
    act(() => {
      useUnsavedChangesStore.getState().pendingCallback!()
      useUnsavedChangesStore.getState().dismissConfirm()
    })
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })

  it('guards logout when dirty', () => {
    const logout = vi.fn().mockResolvedValue(undefined)
    mockUseAuth.mockReturnValue({
      user: { id: 1, username: 'ada', email: null, must_change_password: false, is_admin: false, is_active: true },
      online: true,
      logout,
    })
    useUnsavedChangesStore.getState().setDirty(true)
    wrap()
    act(() => {
      fireEvent.click(screen.getByTitle('Sign out'))
    })
    expect(useUnsavedChangesStore.getState().pendingCallback).not.toBeNull()
    expect(logout).not.toHaveBeenCalled()
  })
})
