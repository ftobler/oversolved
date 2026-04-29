import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from '../../contexts/AuthContext'
import Documents from '../Documents'

describe('Documents clone', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  const baseFetch = (extra: (url: string) => Promise<Response> | null) =>
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
      if (url.startsWith('/api/documents?')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            documents: [
              { uuid: 'doc-1', name: 'TestDoc', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-02T00:00:00Z', is_owner: true, owner_username: 'admin' },
            ],
          }),
        } as Response)
      }
      return extra(url) ?? Promise.resolve({ ok: false, status: 404 } as Response)
    })

  it('shows clone button on document tiles', async () => {
    vi.stubGlobal('fetch', baseFetch(() => null))

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

    const cloneBtn = screen.getByTitle('Clone document')
    expect(cloneBtn).toBeInTheDocument()
  })

  it('calls clone API when clone button is clicked', async () => {
    const fetchMock = baseFetch((url) => {
      if (url === '/api/documents/doc-1/clone') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ uuid: 'doc-2', name: 'TestDoc (Clone)' }),
        } as Response)
      }
      return null
    })
    vi.stubGlobal('fetch', fetchMock)

    const originalHref = window.location.href
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { href: originalHref },
    })

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

    const cloneBtn = screen.getByTitle('Clone document')
    fireEvent.click(cloneBtn)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/documents/doc-1/clone', { method: 'POST' })
    })

    expect(window.location.href).toBe('/documents/doc-2')
  })
})
