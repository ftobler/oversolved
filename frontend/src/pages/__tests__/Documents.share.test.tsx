import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, fireEvent } from '@testing-library/react'
import { freshLocalDb, renderDocuments, gotoCloudDomain } from './documentsHarness'

// Sharing lives in the cloud domain (the local library is identity-free), so each
// test signs in, switches to Cloud, and the fetch stub backs the cloud store.
describe('Documents share', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    freshLocalDb()
  })

  const mockFetch = (docs: Record<string, unknown>[] = []) =>
    vi.fn((url: string): Promise<Response> => {
      if (url === '/api/auth/me') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ user: { id: 1, username: 'admin', must_change_password: false } }),
        } as Response)
      }
      if (url === '/api/users/me/preferences') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ document_sort: 'date_newest_first' }),
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

  it('shows share button on document tiles', async () => {
    vi.stubGlobal('fetch', mockFetch([
      { uuid: 'doc-1', name: 'TestDoc', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-02T00:00:00Z', is_owner: true, owner_username: 'admin' },
    ]))

    renderDocuments()
    await gotoCloudDomain()

    await waitFor(() => {
      expect(screen.getByText('admin/TestDoc')).toBeInTheDocument()
    })

    const shareBtn = screen.getByTitle('Share document')
    expect(shareBtn).toBeInTheDocument()
  })

  it('hides delete button for non-owned documents', async () => {
    vi.stubGlobal('fetch', mockFetch([
      { uuid: 'doc-1', name: 'SharedDoc', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-02T00:00:00Z', is_owner: false, owner_username: 'otheruser' },
    ]))

    renderDocuments()
    await gotoCloudDomain()

    await waitFor(() => {
      expect(screen.getByText('otheruser/SharedDoc')).toBeInTheDocument()
    })

    expect(screen.queryByTitle('Delete document')).not.toBeInTheDocument()
  })

  // Regression test for the unshare confirm: it used to end in
  // .catch(() => undefined), so a failed leaveShare closed the dialog with no
  // report at all, unlike every sibling action which raises the error banner.
  it('surfaces an unshare failure instead of swallowing it', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit): Promise<Response> => {
      if (url === '/api/auth/me') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ user: { id: 1, username: 'admin', must_change_password: false } }),
        } as Response)
      }
      if (url === '/api/users/me/preferences') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ document_sort: 'date_newest_first' }),
        } as Response)
      }
      if (url === '/api/documents/doc-1/share' && init?.method === 'DELETE') {
        return Promise.resolve({
          ok: false,
          status: 403,
          text: () => Promise.resolve(JSON.stringify({ error: 'share no longer exists' })),
        } as unknown as Response)
      }
      if (url.startsWith('/api/documents')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            documents: [
              { uuid: 'doc-1', name: 'SharedDoc', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-02T00:00:00Z', is_owner: false, owner_username: 'otheruser' },
            ],
          }),
        } as Response)
      }
      return Promise.resolve({ ok: false, status: 404 } as Response)
    }))

    renderDocuments()
    await gotoCloudDomain()

    await waitFor(() => {
      expect(screen.getByText('otheruser/SharedDoc')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTitle('Unshare document'))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))

    await waitFor(() => {
      expect(screen.getByText('Error: share no longer exists')).toBeInTheDocument()
    })
  })
})
