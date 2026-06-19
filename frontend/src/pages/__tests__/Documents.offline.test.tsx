import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { freshLocalDb, renderDocuments, gotoCloudDomain } from './documentsHarness'
import { getLocalStore } from '@/stores/documentStore'

// session-logout-offline: two deliberate transitions out of the cloud domain back
// to local-only. Logout drops the credential (non-destructive); losing the server
// mid-session falls back gracefully instead of stranding the user on an error.

function res(body: unknown, ok = true, status = 200): Response {
  return {
    ok, status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response
}

const authOk = res({ user: { id: 1, username: 'admin', must_change_password: false } })
const prefsOk = res({ document_sort: 'date_newest_first' })

describe('Documents offline + logout transitions', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    freshLocalDb()
    sessionStorage.setItem('docDomainBridgeSeen', '1')  // suppress the post-login bridge prompt
  })

  afterEach(() => {
    cleanup()
  })

  it('falls back to local when the cloud list fails on a connection error', async () => {
    const local = getLocalStore()
    const { uuid } = await local.create('LocalDoc')
    await local.save(uuid, { content: 'x' })

    const fetchMock = vi.fn((url: string): Promise<Response> => {
      if (url === '/api/auth/me') return Promise.resolve(authOk)
      if (url === '/api/users/me/preferences') return Promise.resolve(prefsOk)
      // Server unreachable: a rejected fetch with no response (a TypeError), not a
      // status code -- this is the offline signal.
      if (url.startsWith('/api/documents')) return Promise.reject(new TypeError('Failed to fetch'))
      return Promise.resolve(res({}, false, 404))
    })
    vi.stubGlobal('fetch', fetchMock)

    renderDocuments()
    await gotoCloudDomain()  // the cloud list rejects -> go offline

    // The view drops back to local: a friendly notice, the local doc, and the cloud
    // domain switch is gone (cloud is no longer available).
    await screen.findByText('Cloud unavailable. Showing your local documents.')
    // The local list re-renders asynchronously (IndexedDB read) after the domain
    // resets, so wait for the tile rather than asserting synchronously -- a plain
    // getByText races the re-render and is flaky under CI timing.
    await screen.findByText('local/LocalDoc')
    await waitFor(() => {
      expect(screen.queryByTitle('Cloud documents')).not.toBeInTheDocument()
    })
  })

  it('logout drops the cloud domain and leaves the local library intact', async () => {
    const local = getLocalStore()
    const { uuid } = await local.create('LocalDoc')
    await local.save(uuid, { content: 'x' })

    const fetchMock = vi.fn((url: string, init?: RequestInit): Promise<Response> => {
      if (url === '/api/auth/me') return Promise.resolve(authOk)
      if (url === '/api/users/me/preferences') return Promise.resolve(prefsOk)
      if (url === '/api/auth/logout' && init?.method === 'POST') return Promise.resolve(res({}))
      return Promise.resolve(res({ documents: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    renderDocuments()

    // Signed in: the cloud domain switch is present.
    await screen.findByTitle('Cloud documents')

    fireEvent.click(screen.getByTitle('Sign out'))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST' }))
    })
    // Back to guest-with-local-only: cloud switch gone, local doc untouched.
    await waitFor(() => {
      expect(screen.queryByTitle('Cloud documents')).not.toBeInTheDocument()
    })
    // Same async-local-list race as above: wait for the tile.
    await screen.findByText('local/LocalDoc')
    expect((await local.load(uuid)).content).toBe('x')
  })
})
