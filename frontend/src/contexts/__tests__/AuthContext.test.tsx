import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, screen, act, renderHook, fireEvent } from '@testing-library/react'
import type { ReactNode } from 'react'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import type { User } from '@/contexts/AuthContext'

vi.mock('@/utils/core/httpClient', () => ({
  http: {
    getJson: vi.fn(),
    postJson: vi.fn(),
  },
  HttpError: class extends Error {
    status: number
    body: string
    constructor(status: number, body: string) {
      super(`HTTP ${status}`)
      this.name = 'HttpError'
      this.status = status
      this.body = body
    }
  },
}))

import { http } from '@/utils/core/httpClient'

const testUser: User = {
  id: 1,
  username: 'testuser',
  email: 'test@example.com',
  must_change_password: false,
  is_admin: false,
  is_active: true,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function TestConsumer() {
  const { user, loading, online, setUser, logout } = useAuth()
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="online">{String(online)}</span>
      <span data-testid="user">{user ? JSON.stringify(user) : 'null'}</span>
      <button data-testid="logout" onClick={() => logout()}>
        Logout
      </button>
      <button
        data-testid="set-user"
        onClick={() =>
          setUser({
            id: 2,
            username: 'newuser',
            email: null,
            must_change_password: false,
            is_admin: true,
            is_active: true,
          })
        }
      >
        Set User
      </button>
    </div>
  )
}

function renderAuth(children?: ReactNode) {
  return render(<AuthProvider>{children ?? <TestConsumer />}</AuthProvider>)
}

describe('AuthContext', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  describe('loading state', () => {
    it('starts with loading=true and transitions to false after fetch resolves', async () => {
      const { promise, resolve } = deferred<{ user: User }>()
      vi.mocked(http.getJson).mockReturnValue(promise)

      renderAuth()
      expect(screen.getByTestId('loading').textContent).toBe('true')

      await act(async () => {
        resolve({ user: testUser })
      })
      await waitFor(() => {
        expect(screen.getByTestId('loading').textContent).toBe('false')
      })
    })

    it('transitions loading to false when fetch rejects', async () => {
      const { promise, reject } = deferred<{ user: User }>()
      vi.mocked(http.getJson).mockReturnValue(promise)

      renderAuth()
      expect(screen.getByTestId('loading').textContent).toBe('true')

      await act(async () => {
        reject(new Error('fetch failed'))
      })
      await waitFor(() => {
        expect(screen.getByTestId('loading').textContent).toBe('false')
      })
    })
  })

  describe('authentication success', () => {
    it('sets user when /api/auth/me succeeds', async () => {
      vi.mocked(http.getJson).mockResolvedValue({ user: testUser })

      renderAuth()
      await waitFor(() => {
        expect(screen.getByTestId('loading').textContent).toBe('false')
      })
      expect(screen.getByTestId('user').textContent).toBe(JSON.stringify(testUser))
      expect(http.getJson).toHaveBeenCalledWith('/api/auth/me')
    })
  })

  describe('authentication failure', () => {
    it('keeps user null when /api/auth/me fails', async () => {
      vi.mocked(http.getJson).mockRejectedValue(new Error('unauthorized'))

      renderAuth()
      await waitFor(() => {
        expect(screen.getByTestId('loading').textContent).toBe('false')
      })
      expect(screen.getByTestId('user').textContent).toBe('null')
    })
  })

  describe('logout', () => {
    it('calls /api/auth/logout and clears user', async () => {
      vi.mocked(http.getJson).mockResolvedValue({ user: testUser })
      vi.mocked(http.postJson).mockResolvedValue(undefined)

      renderAuth()
      await waitFor(() => {
        expect(screen.getByTestId('loading').textContent).toBe('false')
      })

      await act(async () => {
        fireEvent.click(screen.getByTestId('logout'))
      })

      expect(http.postJson).toHaveBeenCalledWith('/api/auth/logout')
      await waitFor(() => {
        expect(screen.getByTestId('user').textContent).toBe('null')
      })
    })

    it('clears user even when logout API returns an error', async () => {
      vi.mocked(http.getJson).mockResolvedValue({ user: testUser })
      vi.mocked(http.postJson).mockRejectedValue(new Error('server error'))

      renderAuth()
      await waitFor(() => {
        expect(screen.getByTestId('loading').textContent).toBe('false')
      })

      await act(async () => {
        fireEvent.click(screen.getByTestId('logout'))
      })

      await waitFor(() => {
        expect(screen.getByTestId('user').textContent).toBe('null')
      })
      expect(http.postJson).toHaveBeenCalledWith('/api/auth/logout')
    })
  })

  // session-logout-offline: cloud reachability is part of the session. It starts
  // optimistic, the browser's offline/online events flip it, and logout resets it.
  describe('online / offline', () => {
    it('starts online', async () => {
      vi.mocked(http.getJson).mockResolvedValue({ user: testUser })
      renderAuth()
      await waitFor(() => {
        expect(screen.getByTestId('loading').textContent).toBe('false')
      })
      expect(screen.getByTestId('online').textContent).toBe('true')
    })

    it('flips offline then back online on the browser connectivity events', async () => {
      vi.mocked(http.getJson).mockResolvedValue({ user: testUser })
      renderAuth()
      await waitFor(() => {
        expect(screen.getByTestId('loading').textContent).toBe('false')
      })

      await act(async () => {
        window.dispatchEvent(new Event('offline'))
      })
      expect(screen.getByTestId('online').textContent).toBe('false')

      await act(async () => {
        window.dispatchEvent(new Event('online'))
      })
      expect(screen.getByTestId('online').textContent).toBe('true')
    })

    it('logout resets online to true (next sign-in starts clean)', async () => {
      vi.mocked(http.getJson).mockResolvedValue({ user: testUser })
      vi.mocked(http.postJson).mockResolvedValue(undefined)
      renderAuth()
      await waitFor(() => {
        expect(screen.getByTestId('loading').textContent).toBe('false')
      })

      await act(async () => {
        window.dispatchEvent(new Event('offline'))
      })
      expect(screen.getByTestId('online').textContent).toBe('false')

      await act(async () => {
        fireEvent.click(screen.getByTestId('logout'))
      })
      await waitFor(() => {
        expect(screen.getByTestId('online').textContent).toBe('true')
      })
    })
  })

  describe('setUser', () => {
    it('updates user context when called directly', async () => {
      vi.mocked(http.getJson).mockResolvedValue({ user: testUser })

      renderAuth()
      await waitFor(() => {
        expect(screen.getByTestId('loading').textContent).toBe('false')
      })
      expect(screen.getByTestId('user').textContent).toBe(JSON.stringify(testUser))

      await act(async () => {
        fireEvent.click(screen.getByTestId('set-user'))
      })

      const newUser: User = {
        id: 2,
        username: 'newuser',
        email: null,
        must_change_password: false,
        is_admin: true,
        is_active: true,
      }
      expect(screen.getByTestId('user').textContent).toBe(JSON.stringify(newUser))
    })
  })

  describe('useAuth hook', () => {
    it('returns current context values', async () => {
      const { promise, resolve } = deferred<{ user: User }>()
      vi.mocked(http.getJson).mockReturnValue(promise)

      const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider })

      expect(result.current.loading).toBe(true)
      expect(result.current.user).toBeNull()

      await act(async () => {
        resolve({ user: testUser })
      })

      await waitFor(() => {
        expect(result.current.loading).toBe(false)
      })
      expect(result.current.user).toEqual(testUser)
    })
  })

  // Memoize context values: the value object handed to AuthContext.Provider must
  // keep its identity across renders that do not touch user/loading/online, so a
  // consumer wrapped in React.memo does not re-render for unrelated reasons. It must
  // still change identity when the underlying session state actually changes.
  describe('context value memoization', () => {
    it('keeps the same value object across an unrelated re-render', async () => {
      vi.mocked(http.getJson).mockResolvedValue({ user: testUser })

      const seen: unknown[] = []
      function Recorder({ tick }: { tick: number }) {
        const ctx = useAuth()
        seen.push(ctx)
        return <span data-testid="tick">{tick}</span>
      }

      const { rerender } = render(
        <AuthProvider>
          <Recorder tick={0} />
        </AuthProvider>,
      )
      await waitFor(() => {
        expect(screen.getByTestId('tick').textContent).toBe('0')
      })

      // Re-render the tree with a prop change that has nothing to do with auth
      // state; the AuthProvider itself re-renders too since it is the parent.
      rerender(
        <AuthProvider>
          <Recorder tick={1} />
        </AuthProvider>,
      )
      await waitFor(() => {
        expect(screen.getByTestId('tick').textContent).toBe('1')
      })

      expect(seen.length).toBeGreaterThanOrEqual(2)
      expect(seen[seen.length - 1]).toBe(seen[seen.length - 2])
    })

    it('produces a new value object when the session state actually changes', async () => {
      const { promise, resolve } = deferred<{ user: User }>()
      vi.mocked(http.getJson).mockReturnValue(promise)

      const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider })
      const before = result.current
      expect(before.user).toBeNull()

      await act(async () => {
        resolve({ user: testUser })
      })
      await waitFor(() => {
        expect(result.current.loading).toBe(false)
      })

      expect(result.current).not.toBe(before)
      expect(result.current.user).toEqual(testUser)
    })
  })
})
