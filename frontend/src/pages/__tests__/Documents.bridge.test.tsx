import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, cleanup, render, fireEvent } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { freshLocalDb } from './documentsHarness'
import { getLocalStore } from '@/stores/documentStore'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import type { User } from '@/contexts/AuthContext'
import Documents from '@/pages/Documents'

// The post-login bridge prompt ("You're signed in. Copy your N local documents to
// Cloud?") is gated by sessionStorage['docDomainBridgeSeen']. Logging out should
// re-arm it so a subsequent sign-in re-offers the mirror, even if the user had
// previously seen or dismissed it in the same tab. Only an active logged-in
// session keeps the gate set; a fresh login is a fresh offer.

const adminUser: User = {
  id: 1, username: 'admin', email: null,
  must_change_password: false, is_admin: true, is_active: true,
}

// A tiny control panel rendered alongside Documents inside the same AuthProvider.
// Buttons invoke the real useAuth().setUser, mirroring a header-driven sign-in /
// sign-out flow without re-mounting the tree.
function AuthControls() {
  const { setUser } = useAuth()
  return (
    <div>
      <button onClick={() => setUser(adminUser)} data-testid="sign-in">sign-in</button>
      <button onClick={() => setUser(null)} data-testid="sign-out">sign-out</button>
    </div>
  )
}

function res(body: unknown, ok = true, status = 200): Response {
  return {
    ok, status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response
}
const prefsOk = res({ document_sort: 'date_newest_first' })

describe('post-login bridge prompt re-arming on logout', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    freshLocalDb()
    sessionStorage.clear()
  })

  afterEach(() => {
    cleanup()
  })

  it('re-offers after a logout -> sign-in cycle, even after an explicit Dismiss', async () => {
    const local = getLocalStore()
    const { uuid } = await local.create('LocalDoc')
    await local.save(uuid, { content: 'x' })

    // Cloud calls (preferences + document list) respond OK once the user is signed
    // in and the cloud domain becomes available.
    const fetchMock = vi.fn((url: string): Promise<Response> => {
      // /api/auth/me (mount-time) -> 401 guest so user starts null.
      if (url === '/api/auth/me') return Promise.resolve(res({}, false, 401))
      if (url === '/api/users/me/preferences') return Promise.resolve(prefsOk)
      return Promise.resolve(res({ documents: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <BrowserRouter>
        <AuthProvider>
          <AuthControls />
          <Documents />
        </AuthProvider>
      </BrowserRouter>,
    )

    // Wait for the AuthProvider mount fetch to settle -> guest (no prompt yet).
    await waitFor(() => {
      expect(screen.queryByText(/Copy your 1 local document to Cloud/)).not.toBeInTheDocument()
    })

    // First sign-in: bridge prompt appears.
    fireEvent.click(screen.getByTestId('sign-in'))
    const prompt = await screen.findByText(/Copy your 1 local document to Cloud/)

    // Explicit Dismiss -- a deliberate "not now" within this session.
    const dismiss = prompt.closest('div')!.querySelector('button.btn-dismiss')!
    fireEvent.click(dismiss)
    await waitFor(() => {
      expect(screen.queryByText(/Copy your 1 local document to Cloud/)).not.toBeInTheDocument()
    })
    expect(sessionStorage.getItem('docDomainBridgeSeen')).toBe('1')

    // Sign out: the cloud domain vanishes, the gate is re-armed for the next sign-in.
    fireEvent.click(screen.getByTestId('sign-out'))
    await waitFor(() => {
      expect(screen.queryByText(/Copy your 1 local document to Cloud/)).not.toBeInTheDocument()
    })
    expect(sessionStorage.getItem('docDomainBridgeSeen')).toBeNull()

    // Second sign-in: the bridge prompt reappears despite the earlier Dismiss.
    fireEvent.click(screen.getByTestId('sign-in'))
    await screen.findByText(/Copy your 1 local document to Cloud/)
  })

  it('does not re-nag on reload of an already-signed-in session that was dismissed', async () => {
    const local = getLocalStore()
    const { uuid } = await local.create('LocalDoc')
    await local.save(uuid, { content: 'x' })

    // Simulate a reload mid-session: the bridge was already offered + dismissed in
    // a prior tab life (flag set), and the session cookie restores the user on
    // mount (auth/me -> admin immediately, never guest first).
    sessionStorage.setItem('docDomainBridgeSeen', '1')

    const fetchMock = vi.fn((url: string): Promise<Response> => {
      if (url === '/api/auth/me') {
        return Promise.resolve(res({ user: adminUser }))
      }
      if (url === '/api/users/me/preferences') return Promise.resolve(prefsOk)
      return Promise.resolve(res({ documents: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <BrowserRouter>
        <AuthProvider>
          <AuthControls />
          <Documents />
        </AuthProvider>
      </BrowserRouter>,
    )

    // Cloud domain comes up (user != null); the dismissed flag must stay set so
    // the bridge prompt does NOT reappear. Wait long enough for the bridge effect's
    // local list to settle -- if it were going to fire, it would have by now.
    await screen.findByText('My Documents')
    await waitFor(() => {
      expect(sessionStorage.getItem('docDomainBridgeSeen')).toBe('1')
    })
    expect(screen.queryByText(/Copy your 1 local document to Cloud/)).not.toBeInTheDocument()
  })
})