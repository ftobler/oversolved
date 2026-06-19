import { describe, it, expect, beforeEach, vi } from 'vitest'

// Static build: no auth endpoint. The session is guest-first (user === null) and
// must NOT hit the network -- static IS the not-logged-in state, so it simply
// stays a guest forever. No synthetic local user any more.
vi.mock('@/config/capabilities', () => ({ hasBackend: false }))

import { render, screen, waitFor } from '@testing-library/react'
import { AuthProvider, useAuth } from '../AuthContext'

function Probe() {
  const { user, loading } = useAuth()
  return <div>{loading ? 'loading' : `user:${user?.username ?? 'none'}`}</div>
}

describe('AuthContext (static / no backend)', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(() => { throw new Error('network must not be hit in static mode') }) as unknown as typeof fetch
  })

  it('stays a guest (no user) with no network call', async () => {
    render(<AuthProvider><Probe /></AuthProvider>)
    await waitFor(() => expect(screen.getByText('user:none')).toBeInTheDocument())
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})
