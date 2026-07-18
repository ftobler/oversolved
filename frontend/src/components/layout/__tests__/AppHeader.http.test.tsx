import { describe, it, expect, vi } from 'vitest'

// Server build: login is reachable. The header is the view half of the one
// guest-first session -- it shows a "Sign in" affordance when guest and the
// account name + logout when signed in. (three-state header.)
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

import { render, screen, fireEvent } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import AppHeader from '../AppHeader'

function wrap() {
  return render(
    <BrowserRouter>
      <AppHeader title="Test" />
    </BrowserRouter>,
  )
}

describe('AppHeader (http / server reachable)', () => {
  const ada = { id: 1, username: 'ada', email: null, must_change_password: false, is_admin: false, is_active: true }

  it('guest sees a Sign in affordance, no username or logout', () => {
    mockUseAuth.mockReturnValue({ user: null, online: true, logout: vi.fn() })
    wrap()
    const signIn = screen.getByTitle('Sign in')
    expect(signIn).toBeInTheDocument()
    expect(signIn.getAttribute('href')).toBe('/login')
    expect(screen.queryByTitle('Sign out')).not.toBeInTheDocument()
    expect(screen.queryByText('cloud not available')).not.toBeInTheDocument()
  })

  it('signed-in user sees the account name and a logout button, no Sign in', () => {
    mockUseAuth.mockReturnValue({ user: ada, online: true, logout: vi.fn() })
    wrap()
    expect(screen.getByText('ada')).toBeInTheDocument()
    expect(screen.getByTitle('Sign out')).toBeInTheDocument()
    expect(screen.queryByTitle('Sign in')).not.toBeInTheDocument()
    expect(screen.queryByText('offline')).not.toBeInTheDocument()
  })

  // session-logout-offline: the server went away mid-session. Still signed in (the
  // credential is held), so the offline marker shows alongside the account and
  // logout stays available -- working on the local library.
  it('signed-in but offline shows an offline marker, keeps name and logout', () => {
    mockUseAuth.mockReturnValue({ user: ada, online: false, logout: vi.fn() })
    wrap()
    expect(screen.getByText('offline')).toBeInTheDocument()
    expect(screen.getByText('ada')).toBeInTheDocument()
    expect(screen.getByTitle('Sign out')).toBeInTheDocument()
  })

  // Bug reporting lives in the header, not the admin debug drawer: any user hits
  // bugs, and the drawer is gated.
  it('opens the bug report dialog from the header button', () => {
    mockUseAuth.mockReturnValue({ user: null, online: true, logout: vi.fn() })
    wrap()
    expect(screen.queryByText('Report a Bug')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTitle('Report a bug'))
    expect(screen.getByText('Report a Bug')).toBeInTheDocument()
  })
})
