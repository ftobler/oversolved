import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, fireEvent } from '@testing-library/react'
import { freshLocalDb, renderDocuments, gotoCloudDomain } from './documentsHarness'

// Trash is a cloud-domain lifecycle view (the local library has no server-side
// trash), so each test signs in and switches to the Cloud domain to reach it.
const authOk = {
  ok: true,
  json: () => Promise.resolve({ user: { id: 1, username: 'admin', must_change_password: false } }),
} as Response

const prefsOk = {
  ok: true,
  json: () => Promise.resolve({ document_sort: 'date_newest_first' }),
} as Response

describe('Documents trash', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    freshLocalDb()
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const mockFetch = (docs: Record<string, unknown>[] = [], trash: Record<string, unknown>[] = []) => {
    return vi.fn((url: string): Promise<Response> => {
      if (url === '/api/auth/me') return Promise.resolve(authOk)
      if (url === '/api/users/me/preferences') return Promise.resolve(prefsOk)
      if (url === '/api/documents/trash') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ documents: trash }),
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

  it('shows trash button', async () => {
    vi.stubGlobal('fetch', mockFetch())

    renderDocuments()
    await gotoCloudDomain()

    await waitFor(() => {
      expect(screen.getByTitle('Trash')).toBeInTheDocument()
    })
  })

  it('clicking trash button shows trash view', async () => {
    vi.stubGlobal('fetch', mockFetch())

    renderDocuments()
    await gotoCloudDomain()

    await waitFor(() => {
      expect(screen.getByTitle('Trash')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTitle('Trash'))

    await waitFor(() => {
      expect(screen.getByText('Trash is empty.')).toBeInTheDocument()
    })
  })

  it('trash view shows deleted documents', async () => {
    vi.stubGlobal('fetch', mockFetch([], [
      { uuid: 'trash-1', name: 'Deleted Doc', owner_username: 'admin', deleted_at: '2024-04-01T00:00:00Z', created_at: '2024-01-01T00:00:00Z' },
    ]))

    renderDocuments()
    await gotoCloudDomain()

    await waitFor(() => {
      expect(screen.getByTitle('Trash')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTitle('Trash'))

    await waitFor(() => {
      expect(screen.getByText('admin/Deleted Doc')).toBeInTheDocument()
    })
  })

  it('recover button calls recover API', async () => {
    const fetchMock = vi.fn((url: string): Promise<Response> => {
      if (url === '/api/auth/me') return Promise.resolve(authOk)
      if (url === '/api/users/me/preferences') return Promise.resolve(prefsOk)
      if (url === '/api/documents/trash') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            documents: [
              { uuid: 'trash-1', name: 'Deleted Doc', owner_username: 'admin', deleted_at: '2024-04-01T00:00:00Z', created_at: '2024-01-01T00:00:00Z' },
            ],
          }),
        } as Response)
      }
      if (url === '/api/documents/trash-1/recover') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'recovered' }),
        } as Response)
      }
      if (url.startsWith('/api/documents')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ documents: [] }),
        } as Response)
      }
      return Promise.resolve({ ok: false, status: 404 } as Response)
    })
    vi.stubGlobal('fetch', fetchMock)

    renderDocuments()
    await gotoCloudDomain()

    await waitFor(() => {
      expect(screen.getByTitle('Trash')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTitle('Trash'))

    await waitFor(() => {
      expect(screen.getByText('admin/Deleted Doc')).toBeInTheDocument()
    })

    const recoverBtn = screen.getByTitle('Recover document')
    fireEvent.click(recoverBtn)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/documents/trash-1/recover',
        expect.objectContaining({ method: 'POST' })
      )
    })
  })
})
