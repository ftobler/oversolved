import { describe, it, expect, vi } from 'vitest'

// Partial mock: the header pulls in the backend bundle (bug report sink), which
// reads `backend` too -- a bare { hasBackend } mock leaves that import undefined.
vi.mock('@/config/capabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/config/capabilities')>()),
  backend: 'static' as const,
  hasBackend: false,
  debugToolsUnrestricted: true,
}))

import { render, screen } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from '@/contexts/AuthContext'
import AppHeader from '../AppHeader'

function wrap() {
  return render(
    <BrowserRouter>
      <AuthProvider>
        <AppHeader title="Test" />
      </AuthProvider>
    </BrowserRouter>
  )
}

describe('AppHeader (static / no backend)', () => {
  // The static build is a deployment where the cloud never existed. The account
  // slot is empty -- no sign-in, no logout, and no "unavailable" marker either:
  // naming a capability this build does not have only teases it.
  it('shows no account slot at all: no sign-in, no logout, no cloud marker', () => {
    wrap()
    expect(screen.queryByTitle('Sign out')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Sign in')).not.toBeInTheDocument()
    expect(screen.queryByText('cloud not available')).not.toBeInTheDocument()
    expect(screen.queryByText(/cloud/i)).not.toBeInTheDocument()
    expect(screen.queryByText('offline')).not.toBeInTheDocument()
  })

  it('does not show the synthetic local username in the header', () => {
    wrap()
    expect(screen.queryByText('local')).not.toBeInTheDocument()
  })
})
