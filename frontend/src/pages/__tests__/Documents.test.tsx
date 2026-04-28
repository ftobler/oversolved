import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { act } from 'react'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from '../../contexts/AuthContext'
import Documents from '../Documents'

describe('Documents sidebar', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const mockFetch = (docs: Record<string, unknown>[] = []) => {
    return vi.fn((url: string): Promise<Response> => {
      if (url === '/api/auth/me') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ user: { id: 1, username: 'admin', must_change_password: false } }),
        } as Response)
      }
      if (url.startsWith('/api/documents')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ documents: docs }),
        } as Response)
      }
      return Promise.resolve({ ok: false, status: 404 } as Response)
    })
  }

  it('renders sidebar with three filter items', async () => {
    vi.stubGlobal('fetch', mockFetch())

    render(
      <BrowserRouter>
        <AuthProvider>
          <Documents />
        </AuthProvider>
      </BrowserRouter>
    )

    await waitFor(() => {
      expect(screen.getByText('My Documents')).toBeInTheDocument()
    })

    expect(screen.getByText('Shared with me')).toBeInTheDocument()
    expect(screen.getByText('Public Documents')).toBeInTheDocument()
  })

  it('My Documents is active by default', async () => {
    vi.stubGlobal('fetch', mockFetch())

    render(
      <BrowserRouter>
        <AuthProvider>
          <Documents />
        </AuthProvider>
      </BrowserRouter>
    )

    await waitFor(() => {
      expect(screen.getByText('My Documents')).toBeInTheDocument()
    })

    const myDocs = screen.getByText('My Documents').closest('.sidebar-item')
    expect(myDocs).toHaveClass('active')
  })

  it('clicking Shared with me changes active filter and fetches with filter=shared', async () => {
    const fetchMock = mockFetch()
    vi.stubGlobal('fetch', fetchMock)

    render(
      <BrowserRouter>
        <AuthProvider>
          <Documents />
        </AuthProvider>
      </BrowserRouter>
    )

    await waitFor(() => {
      expect(screen.getByText('Shared with me')).toBeInTheDocument()
    })

    const sharedItem = screen.getByText('Shared with me').closest('.sidebar-item')!
    fireEvent.click(sharedItem)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('filter=shared')
      )
    })

    expect(sharedItem).toHaveClass('active')
  })

  it('clicking Public Documents changes active filter and fetches with filter=public', async () => {
    const fetchMock = mockFetch()
    vi.stubGlobal('fetch', fetchMock)

    render(
      <BrowserRouter>
        <AuthProvider>
          <Documents />
        </AuthProvider>
      </BrowserRouter>
    )

    await waitFor(() => {
      expect(screen.getByText('Public Documents')).toBeInTheDocument()
    })

    const publicItem = screen.getByText('Public Documents').closest('.sidebar-item')!
    fireEvent.click(publicItem)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('filter=public')
      )
    })

    expect(publicItem).toHaveClass('active')
  })

  it('old filterShared toggle button is not present', async () => {
    vi.stubGlobal('fetch', mockFetch())

    render(
      <BrowserRouter>
        <AuthProvider>
          <Documents />
        </AuthProvider>
      </BrowserRouter>
    )

    await waitFor(() => {
      expect(screen.getByText('My Documents')).toBeInTheDocument()
    })

    expect(screen.queryByTitle('Show shared with me')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Show all documents')).not.toBeInTheDocument()
  })
})

describe('Documents search', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const mockFetch = (docs: Record<string, unknown>[] = []) => {
    return vi.fn((url: string): Promise<Response> => {
      if (url === '/api/auth/me') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ user: { id: 1, username: 'admin', must_change_password: false } }),
        } as Response)
      }
      if (url.startsWith('/api/documents')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ documents: docs }),
        } as Response)
      }
      return Promise.resolve({ ok: false, status: 404 } as Response)
    })
  }

  it('search input triggers debounced API call with search param', async () => {
    const fetchMock = mockFetch()
    vi.stubGlobal('fetch', fetchMock)

    render(
      <BrowserRouter>
        <AuthProvider>
          <Documents />
        </AuthProvider>
      </BrowserRouter>
    )

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Search documents...')).toBeInTheDocument()
    })

    const input = screen.getByPlaceholderText('Search documents...')
    fireEvent.change(input, { target: { value: 'query' } })

    await act(async () => {
      vi.advanceTimersByTime(300)
    })

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('search=query')
      )
    })
  })

  it('search passes filter param correctly alongside search', async () => {
    const fetchMock = mockFetch()
    vi.stubGlobal('fetch', fetchMock)

    render(
      <BrowserRouter>
        <AuthProvider>
          <Documents />
        </AuthProvider>
      </BrowserRouter>
    )

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Search documents...')).toBeInTheDocument()
    })

    const input = screen.getByPlaceholderText('Search documents...')
    fireEvent.change(input, { target: { value: 'alpha' } })

    await act(async () => {
      vi.advanceTimersByTime(300)
    })

    await waitFor(() => {
      const searchCall = fetchMock.mock.calls.find((call: unknown[]) =>
        (call[0] as string).includes('search=alpha')
      )
      expect(searchCall).toBeDefined()
      expect(searchCall![0]).toContain('filter=owned')
    })
  })

  it('clear button resets search', async () => {
    const fetchMock = mockFetch()
    vi.stubGlobal('fetch', fetchMock)

    render(
      <BrowserRouter>
        <AuthProvider>
          <Documents />
        </AuthProvider>
      </BrowserRouter>
    )

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Search documents...')).toBeInTheDocument()
    })

    const input = screen.getByPlaceholderText('Search documents...') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'query' } })

    await act(async () => {
      vi.advanceTimersByTime(300)
    })

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('search=query')
      )
    })

    const clearBtn = screen.getByTitle('Clear search')
    fireEvent.click(clearBtn)

    expect(input.value).toBe('')
  })

  it('no client-side filtering occurs', async () => {
    const fetchMock = vi.fn((url: string): Promise<Response> => {
      if (url === '/api/auth/me') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ user: { id: 1, username: 'admin', must_change_password: false } }),
        } as Response)
      }
      if (url.startsWith('/api/documents')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            documents: [
              { uuid: 'doc-1', name: 'AlphaDoc', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-02T00:00:00Z', is_owner: true, owner_username: 'admin' },
            ],
          }),
        } as Response)
      }
      return Promise.resolve({ ok: false, status: 404 } as Response)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <BrowserRouter>
        <AuthProvider>
          <Documents />
        </AuthProvider>
      </BrowserRouter>
    )

    await waitFor(() => {
      expect(screen.getByText('AlphaDoc')).toBeInTheDocument()
    })

    const input = screen.getByPlaceholderText('Search documents...')
    fireEvent.change(input, { target: { value: 'beta' } })

    await act(async () => {
      vi.advanceTimersByTime(300)
    })

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('search=beta')
      )
    })

    // The component shows whatever the server returns; since our mock returns AlphaDoc for any call,
    // it should still be present (proving filtering is not done client-side).
    expect(screen.queryByText('AlphaDoc')).toBeInTheDocument()
  })
})
