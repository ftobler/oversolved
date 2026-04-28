import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from '../../contexts/AuthContext'
import Documents from '../Documents'

describe('Documents share', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('shows share button on document tiles', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/auth/me') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ user: { id: 1, username: 'admin', must_change_password: false } }),
        } as Response)
      }
      if (url === '/api/documents?sort=modified&include_shared=true') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            documents: [
              { uuid: 'doc-1', name: 'TestDoc', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-02T00:00:00Z', is_owner: true, owner_username: 'admin' },
            ],
          }),
        } as Response)
      }
      return Promise.resolve({ ok: false, status: 404 } as Response)
    }))

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

  it('shows owned by me for own documents', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/auth/me') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ user: { id: 1, username: 'admin', must_change_password: false } }),
        } as Response)
      }
      if (url === '/api/documents?sort=modified&include_shared=true') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            documents: [
              { uuid: 'doc-1', name: 'TestDoc', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-02T00:00:00Z', is_owner: true, owner_username: 'admin' },
            ],
          }),
        } as Response)
      }
      return Promise.resolve({ ok: false, status: 404 } as Response)
    }))

    render(
      <BrowserRouter>
        <AuthProvider>
          <Documents />
        </AuthProvider>
      </BrowserRouter>
    )

    await waitFor(() => {
      expect(screen.getByText('owned by me')).toBeInTheDocument()
    })
  })

  it('shows owned by username for shared documents', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/auth/me') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ user: { id: 1, username: 'admin', must_change_password: false } }),
        } as Response)
      }
      if (url === '/api/documents?sort=modified&include_shared=true') {
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

    render(
      <BrowserRouter>
        <AuthProvider>
          <Documents />
        </AuthProvider>
      </BrowserRouter>
    )

    await waitFor(() => {
      expect(screen.getByText('owned by otheruser')).toBeInTheDocument()
    })
  })

  it('hides delete button for non-owned documents', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/auth/me') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ user: { id: 1, username: 'admin', must_change_password: false } }),
        } as Response)
      }
      if (url === '/api/documents?sort=modified&include_shared=true') {
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
