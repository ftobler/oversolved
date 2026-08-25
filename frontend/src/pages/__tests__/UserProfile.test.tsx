import { useState, StrictMode } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import UserProfile from '@/pages/UserProfile'

const makeUserResponse = (overrides = {}) => ({
  ok: true,
  json: () => Promise.resolve({
    user: {
      id: 1,
      username: 'testuser',
      email: 'test@example.com',
      must_change_password: false,
      is_admin: false,
      is_active: true,
      ...overrides,
    }
  }),
} as Response)

const prefsResponse = {
  ok: true,
  json: () => Promise.resolve({ document_sort: 'date_newest_first' }),
} as Response

describe('UserProfile', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders profile form with email', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/auth/me') return Promise.resolve(makeUserResponse())
      if (url === '/api/users/me/preferences') return Promise.resolve(prefsResponse)
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
  })

  it('updates username on save', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/auth/me') return Promise.resolve(makeUserResponse())
      if (url === '/api/users/me/preferences') return Promise.resolve(prefsResponse)
      if (url === '/api/users/me' && init?.method === 'PUT') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'updated' }),
          text: () => Promise.resolve(JSON.stringify({ status: 'updated' })),
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
      if (url === '/api/auth/me') return Promise.resolve(makeUserResponse())
      if (url === '/api/users/me/preferences') return Promise.resolve(prefsResponse)
      if (url === '/api/users/me' && init?.method === 'PUT') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'updated' }),
          text: () => Promise.resolve(JSON.stringify({ status: 'updated' })),
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

  // A password change with a blank current password is refused client-side:
  // inline error, same validation UX as the mismatch check, and no PUT at all.
  it('requires the current password before sending a password change', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/auth/me') return Promise.resolve(makeUserResponse())
      if (url === '/api/users/me/preferences') return Promise.resolve(prefsResponse)
      if (url === '/api/users/me' && init?.method === 'PUT') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'updated' }),
          text: () => Promise.resolve(JSON.stringify({ status: 'updated' })),
        } as Response)
      }
      return Promise.resolve({ ok: false, status: 404 } as Response)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <BrowserRouter>
        <AuthProvider>
          <UserProfile />
        </AuthProvider>
      </BrowserRouter>,
    )

    await waitFor(() => {
      expect(screen.getByDisplayValue('testuser')).toBeInTheDocument()
    })

    fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'fresh-secret' } })
    fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: 'fresh-secret' } })
    fireEvent.click(screen.getByText('Save'))

    expect(screen.getByText('Current password is required')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/users/me',
      expect.objectContaining({ method: 'PUT' }),
    )
  })

  it('shows password change fields', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/auth/me') return Promise.resolve(makeUserResponse())
      if (url === '/api/users/me/preferences') return Promise.resolve(prefsResponse)
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

  it('shows sort preference radio buttons', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/auth/me') return Promise.resolve(makeUserResponse())
      if (url === '/api/users/me/preferences') return Promise.resolve(prefsResponse)
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

    await waitFor(() => {
      expect(screen.getByText('Alphabetical (A-Z)')).toBeInTheDocument()
    })
    expect(screen.getByText('Date (Newest first)')).toBeInTheDocument()
    expect(screen.getByText('Date (Oldest first)')).toBeInTheDocument()

    const newestFirstRadio = screen.getByDisplayValue('date_newest_first') as HTMLInputElement
    expect(newestFirstRadio.checked).toBe(true)
  })

  // Regression test for the unmount guard in handleSave: navigating away while a
  // save is in flight (PUT still pending) must not let the resolved promise reach
  // back into setUser/setState on a page that is gone. The Probe stays mounted
  // under the same AuthProvider as UserProfile so it can observe whether the
  // late-arriving response leaked into the shared auth context after unmount.
  it('does not leak a late save response into auth state after unmount', async () => {
    function Probe() {
      const { user } = useAuth()
      return <div data-testid="probe-username">{user?.username}</div>
    }

    function Harness() {
      const [showProfile, setShowProfile] = useState(true)
      return (
        <BrowserRouter>
          <AuthProvider>
            <Probe />
            {showProfile && <UserProfile />}
            <button onClick={() => setShowProfile(false)}>hide profile</button>
          </AuthProvider>
        </BrowserRouter>
      )
    }

    let resolvePut!: () => void
    const putPromise = new Promise<void>(resolve => { resolvePut = resolve })

    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/auth/me') return Promise.resolve(makeUserResponse())
      if (url === '/api/users/me/preferences') return Promise.resolve(prefsResponse)
      if (url === '/api/users/me' && init?.method === 'PUT') {
        return putPromise.then(() => ({
          ok: true,
          json: () => Promise.resolve({ status: 'updated' }),
          text: () => Promise.resolve(JSON.stringify({ status: 'updated' })),
        } as Response))
      }
      return Promise.resolve({ ok: false, status: 404 } as Response)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<Harness />)

    await waitFor(() => {
      expect(screen.getByDisplayValue('testuser')).toBeInTheDocument()
    })
    expect(screen.getByTestId('probe-username').textContent).toBe('testuser')

    fireEvent.change(screen.getByDisplayValue('testuser'), { target: { value: 'newname' } })
    fireEvent.click(screen.getByText('Save'))

    // Wait until the save's PUT is actually in flight before navigating away, so
    // the unmount genuinely races the pending await in handleSave.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/users/me', expect.objectContaining({ method: 'PUT' }))
    })

    // Simulate navigating away: unmount UserProfile while AuthProvider/Probe stay.
    fireEvent.click(screen.getByText('hide profile'))
    expect(screen.queryByDisplayValue('newname')).not.toBeInTheDocument()

    // Now let the in-flight save resolve. Without the guard this would call
    // setUser on the (now torn down) UserProfile's behalf and the probe would
    // flip to 'newname'.
    await act(async () => {
      resolvePut()
      await putPromise
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByTestId('probe-username').textContent).toBe('testuser')
  })

  // Regression test for the mountedRef unmount guard: StrictMode's
  // mount/unmount/mount replay runs the cleanup once while keeping the ref
  // object, so a ref that is only ever set false in the cleanup stays false for
  // good and the guarded setLoading(false) after the save never runs. The app
  // mounts under StrictMode (main.tsx), so the save must resolve there too.
  it('resolves a save under StrictMode double-mount', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/auth/me') return Promise.resolve(makeUserResponse())
      if (url === '/api/users/me/preferences') return Promise.resolve(prefsResponse)
      if (url === '/api/users/me' && init?.method === 'PUT') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'updated' }),
          text: () => Promise.resolve(JSON.stringify({ status: 'updated' })),
        } as Response)
      }
      return Promise.resolve({ ok: false, status: 404 } as Response)
    }))

    render(
      <StrictMode>
        <BrowserRouter>
          <AuthProvider>
            <UserProfile />
          </AuthProvider>
        </BrowserRouter>
      </StrictMode>,
    )

    await waitFor(() => {
      expect(screen.getByDisplayValue('testuser')).toBeInTheDocument()
    })

    fireEvent.change(screen.getByDisplayValue('testuser'), { target: { value: 'newname' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => {
      expect(screen.getByText('Profile updated successfully')).toBeInTheDocument()
    })
    // The loading state must have been cleared by the guarded path as well.
    expect(screen.queryByText('Saving…')).not.toBeInTheDocument()
  })

  // The guard's original job survives the re-arm fix: an unmount during an in
  // flight save still swallows the late response instead of painting it.
  it('under StrictMode, keeps swallowing a late save response after unmount', async () => {
    function Probe() {
      const { user } = useAuth()
      return <div data-testid="probe-username">{user?.username}</div>
    }

    function Harness() {
      const [showProfile, setShowProfile] = useState(true)
      return (
        <StrictMode>
          <BrowserRouter>
            <AuthProvider>
              <Probe />
              {showProfile && <UserProfile />}
              <button onClick={() => setShowProfile(false)}>hide profile</button>
            </AuthProvider>
          </BrowserRouter>
        </StrictMode>
      )
    }

    let resolvePut!: () => void
    const putPromise = new Promise<void>(resolve => { resolvePut = resolve })

    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/auth/me') return Promise.resolve(makeUserResponse())
      if (url === '/api/users/me/preferences') return Promise.resolve(prefsResponse)
      if (url === '/api/users/me' && init?.method === 'PUT') {
        return putPromise.then(() => ({
          ok: true,
          json: () => Promise.resolve({ status: 'updated' }),
          text: () => Promise.resolve(JSON.stringify({ status: 'updated' })),
        } as Response))
      }
      return Promise.resolve({ ok: false, status: 404 } as Response)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<Harness />)

    await waitFor(() => {
      expect(screen.getByDisplayValue('testuser')).toBeInTheDocument()
    })

    fireEvent.change(screen.getByDisplayValue('testuser'), { target: { value: 'newname' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/users/me', expect.objectContaining({ method: 'PUT' }))
    })

    fireEvent.click(screen.getByText('hide profile'))

    await act(async () => {
      resolvePut()
      await putPromise
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByTestId('probe-username').textContent).toBe('testuser')
  })
})
