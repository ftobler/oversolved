import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from '../../contexts/AuthContext'
import Documents from '../Documents'

describe('Documents share', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
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
          json: () => Promise.resolve({ document_sort: 'alphabetical' }),
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

    render(
      <BrowserRouter>
        <AuthProvider>
          <Documents />
        </AuthProvider>
      </BrowserRouter>
    )

    await waitFor(() => {
      expect(screen.getByText('TestDoc')).toBeInTheDocument()
    })

    const shareBtn = screen.getByTitle('Share document')
    expect(shareBtn).toBeInTheDocument()
  })

  it('hides delete button for non-owned documents', async () => {
    vi.stubGlobal('fetch', mockFetch([
      { uuid: 'doc-1', name: 'SharedDoc', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-02T00:00:00Z', is_owner: false, owner_username: 'otheruser' },
    ]))

    render(
      <BrowserRouter>
        <AuthProvider>
          <Documents />
        </AuthProvider>
      </BrowserRouter>
    )

    await waitFor(() => {
      expect(screen.getByText('SharedDoc')).toBeInTheDocument()
    })

    expect(screen.queryByTitle('Delete document')).not.toBeInTheDocument()
  })
})
