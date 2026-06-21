import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, cleanup } from '@testing-library/react'
import { freshLocalDb, renderDocuments } from './documentsHarness'

// A guest on a server build has no Cloud section to navigate, only the header
// sign-in. The sidebar offers the upgrade right where the Cloud section would be,
// so signing in is one click from the library.

function res(body: unknown, ok = true, status = 200): Response {
  return {
    ok, status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response
}

const prefsOk = res({ document_sort: 'date_newest_first' })

describe('Documents sidebar sign-in affordance', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    freshLocalDb()
    sessionStorage.setItem('docDomainBridgeSeen', '1')
  })

  afterEach(() => {
    cleanup()
  })

  it('offers a sign-in link in the sidebar when a guest on a server build', async () => {
    // Guest: /api/auth/me rejects with 401, so the session stays guest.
    const fetchMock = vi.fn((url: string): Promise<Response> => {
      if (url === '/api/auth/me') return Promise.resolve(res({}, false, 401))
      return Promise.resolve(res({ documents: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    renderDocuments()

    const link = await screen.findByTitle('Sign in to Cloud')
    expect(link).toHaveAttribute('href', '/login')
    // The cloud-domain entries are not reachable as a guest.
    expect(screen.queryByText('My Documents')).not.toBeInTheDocument()
  })

  it('hides the sidebar sign-in link once signed in', async () => {
    const fetchMock = vi.fn((url: string): Promise<Response> => {
      if (url === '/api/auth/me') {
        return Promise.resolve(res({ user: { id: 1, username: 'admin', must_change_password: false } }))
      }
      if (url === '/api/users/me/preferences') return Promise.resolve(prefsOk)
      return Promise.resolve(res({ documents: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    renderDocuments()

    // Signed in: the real Cloud section shows, the sidebar sign-in prompt does not.
    await screen.findByText('My Documents')
    await waitFor(() => {
      expect(screen.queryByTitle('Sign in to Cloud')).not.toBeInTheDocument()
    })
  })
})
