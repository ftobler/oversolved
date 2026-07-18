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
  it('shows cloud-not-available indicator instead of username and logout', () => {
    wrap()
    expect(screen.getByText('cloud not available')).toBeInTheDocument()
    expect(screen.queryByTitle('Sign out')).not.toBeInTheDocument()
  })

  it('does not show the synthetic local username in the header', () => {
    wrap()
    expect(screen.queryByText('local')).not.toBeInTheDocument()
  })
})
