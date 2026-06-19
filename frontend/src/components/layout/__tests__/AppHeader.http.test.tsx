import { describe, it, expect, vi } from 'vitest'

// Server build: login is reachable. The header is the view half of the one
// guest-first session -- it shows a "Sign in" affordance when guest and the
// account name + logout when signed in. (static-build-notes: three-state header.)
vi.mock('@/config/capabilities', () => ({ hasBackend: true }))

const mockUseAuth = vi.fn()
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

import { render, screen } from '@testing-library/react'
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
  it('guest sees a Sign in affordance, no username or logout', () => {
    mockUseAuth.mockReturnValue({ user: null, logout: vi.fn() })
    wrap()
    const signIn = screen.getByTitle('Sign in')
    expect(signIn).toBeInTheDocument()
    expect(signIn.getAttribute('href')).toBe('/login')
    expect(screen.queryByTitle('Sign out')).not.toBeInTheDocument()
    expect(screen.queryByText('cloud not available')).not.toBeInTheDocument()
  })

  it('signed-in user sees the account name and a logout button, no Sign in', () => {
    mockUseAuth.mockReturnValue({
      user: { id: 1, username: 'ada', email: null, must_change_password: false, is_admin: false, is_active: true },
      logout: vi.fn(),
    })
    wrap()
    expect(screen.getByText('ada')).toBeInTheDocument()
    expect(screen.getByTitle('Sign out')).toBeInTheDocument()
    expect(screen.queryByTitle('Sign in')).not.toBeInTheDocument()
  })
})
