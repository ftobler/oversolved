import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from '../../contexts/AuthContext'
import UserProfile from '../UserProfile'

describe('UserProfile', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders profile form', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/auth/me') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ user: { id: 1, username: 'testuser', must_change_password: false, is_admin: false, is_active: true } }),
        } as Response)
      }
      return Promise.resolve({ ok: false, status: 404 } as Response)
    }))

    render(
      <BrowserRouter>
        <AuthProvider>
          <UserProfile />
        </AuthProvider>
      </BrowserRouter>
    )

    await waitFor(() => {
      expect(screen.getByDisplayValue('testuser')).toBeInTheDocument()
    })

    expect(screen.getByText('Edit Profile')).toBeInTheDocument()
  })

  it('updates username on save', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/auth/me') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ user: { id: 1, username: 'testuser', must_change_password: false, is_admin: false, is_active: true } }),
        } as Response)
      }
      if (url === '/api/users/me' && init?.method === 'PUT') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'updated' }),
        } as Response)
      }
      return Promise.resolve({ ok: false, status: 404 } as Response)
    }))

    render(
      <BrowserRouter>
        <AuthProvider>
          <UserProfile />
        </AuthProvider>
      </BrowserRouter>
    )

    await waitFor(() => {
      expect(screen.getByDisplayValue('testuser')).toBeInTheDocument()
    })

    const usernameInput = screen.getByDisplayValue('testuser')
    fireEvent.change(usernameInput, { target: { value: 'newname' } })

    const saveBtn = screen.getByText('Save')
    fireEvent.click(saveBtn)

    await waitFor(() => {
      expect(screen.getByText('Profile updated successfully')).toBeInTheDocument()
    })
  })

  it('shows password change fields when button clicked', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/auth/me') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ user: { id: 1, username: 'testuser', must_change_password: false, is_admin: false, is_active: true } }),
        } as Response)
      }
      return Promise.resolve({ ok: false, status: 404 } as Response)
    }))

    render(
      <BrowserRouter>
        <AuthProvider>
          <UserProfile />
        </AuthProvider>
      </BrowserRouter>
    )

    await waitFor(() => {
      expect(screen.getByDisplayValue('testuser')).toBeInTheDocument()
    })

    const changePwBtn = screen.getByText('Change password')
    fireEvent.click(changePwBtn)

    expect(screen.getByLabelText('Current password')).toBeInTheDocument()
    expect(screen.getByLabelText('New password')).toBeInTheDocument()
    expect(screen.getByLabelText('Confirm new password')).toBeInTheDocument()
  })
})
