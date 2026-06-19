import { describe, it, expect, vi } from 'vitest'

vi.mock('@/config/capabilities', () => ({ hasBackend: false }))

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
