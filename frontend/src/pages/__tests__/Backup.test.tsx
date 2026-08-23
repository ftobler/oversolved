import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from '@/contexts/AuthContext'
import Backup from '@/pages/Backup'

describe('Backup', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    window.history.pushState({}, '', '/backup')
  })

  it('redirects non-admin users', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/auth/me') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ user: { id: 1, username: 'regular', must_change_password: false, is_admin: false, is_active: true } }),
        } as Response)
      }
      return Promise.resolve({ ok: false, status: 404 } as Response)
    }))

    render(
      <BrowserRouter>
        <AuthProvider>
          <Backup />
        </AuthProvider>
      </BrowserRouter>
    )

    await waitFor(() => {
      expect(window.location.pathname).toBe('/documents')
    })
    expect(screen.queryByText('Download Backup')).not.toBeInTheDocument()
  })

  it('renders backup controls for admin', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/auth/me') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ user: { id: 1, username: 'admin', must_change_password: false, is_admin: true, is_active: true } }),
        } as Response)
      }
      return Promise.resolve({ ok: false, status: 404 } as Response)
    }))

    render(
      <BrowserRouter>
        <AuthProvider>
          <Backup />
        </AuthProvider>
      </BrowserRouter>
    )

    await waitFor(() => {
      expect(screen.getByText('Download Backup')).toBeInTheDocument()
    })
    expect(screen.getByText('Import Backup')).toBeInTheDocument()
  })
})
