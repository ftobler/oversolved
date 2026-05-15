import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from '@/contexts/AuthContext'
import AdminUsers from '@/pages/AdminUsers'

describe('AdminUsers', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
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
          <AdminUsers />
        </AuthProvider>
      </BrowserRouter>
    )

    await waitFor(() => {
      expect(screen.queryByText('Users')).not.toBeInTheDocument()
    })
  })

  it('renders user list for admin', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/auth/me') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ user: { id: 1, username: 'admin', must_change_password: false, is_admin: true, is_active: true } }),
        } as Response)
      }
      if (url === '/api/admin/users') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            users: [
              { id: 1, username: 'admin', is_admin: true, is_active: true, created_at: '2024-01-01T00:00:00Z' },
              { id: 2, username: 'user1', is_admin: false, is_active: true, created_at: '2024-01-02T00:00:00Z' },
            ],
          }),
        } as Response)
      }
      return Promise.resolve({ ok: false, status: 404 } as Response)
    }))

    render(
      <BrowserRouter>
        <AuthProvider>
          <AdminUsers />
        </AuthProvider>
      </BrowserRouter>
    )

    await waitFor(() => {
      expect(screen.getByText('user1')).toBeInTheDocument()
    })
  })

  it('opens create user dialog', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/auth/me') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ user: { id: 1, username: 'admin', must_change_password: false, is_admin: true, is_active: true } }),
        } as Response)
      }
      if (url === '/api/admin/users') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ users: [] }),
        } as Response)
      }
      return Promise.resolve({ ok: false, status: 404 } as Response)
    }))

    render(
      <BrowserRouter>
        <AuthProvider>
          <AdminUsers />
        </AuthProvider>
      </BrowserRouter>
    )

    await waitFor(() => {
      expect(screen.getByTitle('Create user')).toBeInTheDocument()
    })

    const createBtn = screen.getByTitle('Create user')
    fireEvent.click(createBtn)

    await waitFor(() => {
      expect(screen.getByText('Create User')).toBeInTheDocument()
    })
  })
})
