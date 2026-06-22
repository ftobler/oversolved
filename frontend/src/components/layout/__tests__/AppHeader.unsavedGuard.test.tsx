import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/config/capabilities', () => ({ hasBackend: true }))

const mockUseAuth = vi.fn()
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

import { render, screen, fireEvent } from '@testing-library/react'
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
    window.history.pushState({}, '', '/documents/abc')
  })
  afterEach(() => {
    vi.restoreAllMocks()
    useUnsavedChangesStore.getState().setDirty(false)
  })

  it('does not prompt when there are no unsaved changes', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    wrap()
    fireEvent.click(screen.getByTitle('Documentation'))
    expect(confirm).not.toHaveBeenCalled()
  })

  it('prompts and blocks navigation when dirty and the user cancels', () => {
    useUnsavedChangesStore.getState().setDirty(true)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    wrap()
    const docsLink = screen.getByTitle('Documentation')
    const event = fireEvent.click(docsLink)
    expect(confirm).toHaveBeenCalledOnce()
    // A cancelled click is preventDefault-ed so react-router does not navigate.
    expect(event).toBe(false)
    // Pathname is unchanged and the flag is preserved for the next attempt.
    expect(window.location.pathname).toBe('/documents/abc')
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
  })

  it('prompts then clears the flag and allows navigation when the user confirms', () => {
    useUnsavedChangesStore.getState().setDirty(true)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    wrap()
    fireEvent.click(screen.getByTitle('Documentation'))
    expect(confirm).toHaveBeenCalledOnce()
    // react-router performs the client-side navigation (it preventDefaults the
    // event itself), and the guard has cleared the flag.
    expect(window.location.pathname).toBe('/docs')
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })

  it('guards logout too', async () => {
    const logout = vi.fn().mockResolvedValue(undefined)
    mockUseAuth.mockReturnValue({
      user: { id: 1, username: 'ada', email: null, must_change_password: false, is_admin: false, is_active: true },
      online: true,
      logout,
    })
    useUnsavedChangesStore.getState().setDirty(true)
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    wrap()
    fireEvent.click(screen.getByTitle('Sign out'))
    expect(logout).not.toHaveBeenCalled()
  })
})
