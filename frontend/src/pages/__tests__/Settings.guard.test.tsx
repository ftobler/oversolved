import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { vi } from 'vitest'
import Settings from '../Settings'

// Account pages are signed-in-only. A guest (always the case on the static
// build, where there is no sign-in) must be redirected away rather than shown an
// empty profile form that posts nowhere.
const authState = vi.hoisted(() => ({ user: null as unknown, loading: false }))
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => authState }))
vi.mock('@/components/layout/AppHeader', () => ({ default: () => <div>HEADER</div> }))

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={['/settings/profile']}>
      <Routes>
        <Route path="/settings" element={<Settings />}>
          <Route path="profile" element={<div>PROFILE FORM</div>} />
        </Route>
        <Route path="/documents" element={<div>DOCS LIBRARY</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Settings account guard', () => {
  beforeEach(() => {
    authState.user = null
    authState.loading = false
  })

  it('redirects a guest to the documents library', () => {
    renderSettings()
    expect(screen.getByText('DOCS LIBRARY')).toBeInTheDocument()
    expect(screen.queryByText('PROFILE FORM')).not.toBeInTheDocument()
  })

  it('renders the settings subtree for a signed-in user', () => {
    authState.user = { id: 1, username: 'admin', is_admin: false }
    renderSettings()
    expect(screen.getByText('PROFILE FORM')).toBeInTheDocument()
    expect(screen.queryByText('DOCS LIBRARY')).not.toBeInTheDocument()
  })

  it('renders nothing while the initial auth restore is in flight', () => {
    authState.loading = true
    renderSettings()
    expect(screen.queryByText('PROFILE FORM')).not.toBeInTheDocument()
    expect(screen.queryByText('DOCS LIBRARY')).not.toBeInTheDocument()
  })
})
