import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, fireEvent } from '@testing-library/react'
import { act } from 'react'
import { freshLocalDb, renderDocuments, gotoCloudDomain } from './documentsHarness'

// After the store-home inversion (doc-domain-move), home is the local IndexedDB
// library. The owned/shared/public filters, trash and server-side search are
// cloud-domain concepts, so the cloud-facing tests switch to the Cloud domain
// where the fetch stub backs the HTTP store.
const authOk = {
  ok: true,
  json: () => Promise.resolve({ user: { id: 1, username: 'admin', must_change_password: false } }),
} as Response

const prefsOk = {
  ok: true,
  json: () => Promise.resolve({ document_sort: 'date_newest_first' }),
} as Response

describe('Documents sidebar', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    freshLocalDb()
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const mockFetch = (docs: Record<string, unknown>[] = []) => {
    return vi.fn((url: string): Promise<Response> => {
      if (url === '/api/auth/me') return Promise.resolve(authOk)
      if (url === '/api/users/me/preferences') return Promise.resolve(prefsOk)
      if (url.startsWith('/api/documents')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ documents: docs }),
        } as Response)
      }
      return Promise.resolve({ ok: false, status: 404 } as Response)
    })
  }

  it('renders the Local section and, when signed in, the Cloud section', async () => {
    vi.stubGlobal('fetch', mockFetch())

    renderDocuments()

    // The local section is always present (the local home library always exists).
    await waitFor(() => {
      expect(screen.getByText('Local Documents')).toBeInTheDocument()
    })
    expect(screen.getByText('Local Trash')).toBeInTheDocument()

    // The cloud section appears once the signed-in session resolves.
    await waitFor(() => {
      expect(screen.getByText('My Documents')).toBeInTheDocument()
    })
    expect(screen.getByText('Shared with me')).toBeInTheDocument()
    expect(screen.getByText('Public Documents')).toBeInTheDocument()
    expect(screen.getByText('My Trash')).toBeInTheDocument()

    // Both section dividers are rendered.
    expect(screen.getByText('Local')).toBeInTheDocument()
    expect(screen.getByText('Cloud')).toBeInTheDocument()
  })

  it('offline / signed-out shows only the Local section', async () => {
    // /api/auth/me fails -> no signed-in user -> the cloud domain never appears.
    const fetchMock = vi.fn((url: string): Promise<Response> => {
      if (url === '/api/auth/me') return Promise.resolve({ ok: false, status: 401 } as Response)
      if (url === '/api/users/me/preferences') return Promise.resolve(prefsOk)
      return Promise.resolve({ ok: false, status: 404 } as Response)
    })
    vi.stubGlobal('fetch', fetchMock)

    renderDocuments()

    await waitFor(() => {
      expect(screen.getByText('Local Documents')).toBeInTheDocument()
    })
    expect(screen.getByText('Local Trash')).toBeInTheDocument()

    // No cloud session: the Cloud section and its identity-bound items are absent.
    expect(screen.queryByText('Cloud')).not.toBeInTheDocument()
    expect(screen.queryByText('My Documents')).not.toBeInTheDocument()
    expect(screen.queryByText('Shared with me')).not.toBeInTheDocument()
    expect(screen.queryByText('Public Documents')).not.toBeInTheDocument()
  })

  it('Local Documents is active by default', async () => {
    vi.stubGlobal('fetch', mockFetch())

    renderDocuments()

    await waitFor(() => {
      expect(screen.getByText('Local Documents')).toBeInTheDocument()
    })

    const localDocs = screen.getByText('Local Documents').closest('.sidebar-item')
    expect(localDocs).toHaveClass('active')
  })

  it('clicking Local Trash opens the local trash view', async () => {
    vi.stubGlobal('fetch', mockFetch())

    renderDocuments()

    await waitFor(() => {
      expect(screen.getByText('Local Trash')).toBeInTheDocument()
    })

    const localTrash = screen.getByText('Local Trash').closest('.sidebar-item')!
    fireEvent.click(localTrash)

    expect(localTrash).toHaveClass('active')
    // Empty local trash on a fresh db (await the async trash list resolving).
    await waitFor(() => {
      expect(screen.getByText('Trash is empty.')).toBeInTheDocument()
    })
  })

  it('clicking Shared with me changes active filter and fetches with filter=shared', async () => {
    const fetchMock = mockFetch()
    vi.stubGlobal('fetch', fetchMock)

    renderDocuments()
    await gotoCloudDomain()

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

    renderDocuments()
    await gotoCloudDomain()

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

    renderDocuments()

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
    freshLocalDb()
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const mockFetch = (docs: Record<string, unknown>[] = []) => {
    return vi.fn((url: string): Promise<Response> => {
      if (url === '/api/auth/me') return Promise.resolve(authOk)
      if (url === '/api/users/me/preferences') return Promise.resolve(prefsOk)
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

    renderDocuments()
    await gotoCloudDomain()

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

    renderDocuments()
    await gotoCloudDomain()

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

    renderDocuments()
    await gotoCloudDomain()

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
      if (url === '/api/auth/me') return Promise.resolve(authOk)
      if (url === '/api/users/me/preferences') return Promise.resolve(prefsOk)
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

    renderDocuments()
    await gotoCloudDomain()

    await waitFor(() => {
      expect(screen.getByText('admin/AlphaDoc')).toBeInTheDocument()
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
    expect(screen.queryByText('admin/AlphaDoc')).toBeInTheDocument()
  })
})
