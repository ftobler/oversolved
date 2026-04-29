import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from '../../contexts/AuthContext'
import UserProfile from '../UserProfile'

describe('UserProfile', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders profile form with email and nickname', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/auth/me') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            user: {
              id: 1,
              username: 'testuser',
              email: 'test@example.com',
              nickname: 'test_nick',
              must_change_password: false,
              is_admin: false,
              is_active: true,
            }
          }),
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
    expect(screen.getByDisplayValue('test@example.com')).toBeInTheDocument()
    expect(screen.getByDisplayValue('test_nick')).toBeInTheDocument()
  })

  it('updates username on save', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/auth/me') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            user: {
              id: 1,
              username: 'testuser',
              email: 'test@example.com',
              nickname: 'test_nick',
              must_change_password: false,
              is_admin: false,
              is_active: true,
            }
          }),
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

  it('updates email on save', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/auth/me') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            user: {
              id: 1,
              username: 'testuser',
              email: 'test@example.com',
              nickname: 'test_nick',
              must_change_password: false,
              is_admin: false,
              is_active: true,
            }
          }),
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
      expect(screen.getByDisplayValue('test@example.com')).toBeInTheDocument()
    })

    const emailInput = screen.getByLabelText('Email')
    fireEvent.change(emailInput, { target: { value: 'new@example.com' } })

    const saveBtn = screen.getByText('Save')
    fireEvent.click(saveBtn)

    await waitFor(() => {
      expect(screen.getByText('Profile updated successfully')).toBeInTheDocument()
    })
  })

  it('updates nickname on save', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/auth/me') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            user: {
              id: 1,
              username: 'testuser',
              email: 'test@example.com',
              nickname: 'test_nick',
              must_change_password: false,
              is_admin: false,
              is_active: true,
            }
          }),
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
      expect(screen.getByDisplayValue('test_nick')).toBeInTheDocument()
    })

    const nicknameInput = screen.getByLabelText('Nickname')
    fireEvent.change(nicknameInput, { target: { value: 'new_nick' } })

    const saveBtn = screen.getByText('Save')
    fireEvent.click(saveBtn)

    await waitFor(() => {
      expect(screen.getByText('Profile updated successfully')).toBeInTheDocument()
    })
  })

  it('shows password change fields', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/auth/me') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            user: {
              id: 1,
              username: 'testuser',
              email: 'test@example.com',
              nickname: 'test_nick',
              must_change_password: false,
              is_admin: false,
              is_active: true,
            }
          }),
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

    expect(screen.getByLabelText('Current Password')).toBeInTheDocument()
    expect(screen.getByLabelText('New Password')).toBeInTheDocument()
    expect(screen.getByLabelText('Confirm Password')).toBeInTheDocument()
  })
})
