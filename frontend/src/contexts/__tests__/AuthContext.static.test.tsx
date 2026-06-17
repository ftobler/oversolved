import { describe, it, expect, beforeEach, vi } from 'vitest'

// Static build: no auth endpoint. The provider must surface a local user
// immediately so the ProtectedRoute wall never blocks the app, and must not
// hit the network.
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

  it('provides a local user with no network call', async () => {
    render(<AuthProvider><Probe /></AuthProvider>)
    await waitFor(() => expect(screen.getByText('user:local')).toBeInTheDocument())
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})
