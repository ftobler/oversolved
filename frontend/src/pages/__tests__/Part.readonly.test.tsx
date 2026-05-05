import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '../Part'

vi.mock('../../hooks/solverWs', () => ({
  solverWs: {
    solve: vi.fn().mockResolvedValue({ result: {}, bodies: {}, pick_bodies: {}, _build_state: null }),
    disconnect: vi.fn(),
  },
}))

vi.mock('../../components/Viewport', () => ({
  default: vi.fn(() => null),
  __esModule: true,
}))

describe('Part read-only mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function mockFetch(permission: string) {
    return vi.fn((url: string) => {
      if (url === '/api/auth/me') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ user: { id: 1, username: 'admin', must_change_password: false } }),
        } as Response)
      }
      if (url === '/api/documents/doc-1') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            uuid: 'doc-1',
            name: 'TestDoc',
            content: 'version: 1\nkind: part\nfeatures: []\n',
            permission,
          }),
        } as Response)
      }
      return Promise.resolve({ ok: false, status: 404 } as Response)
    })
  }

  it('shows View Only indicator for view permission', async () => {
    vi.stubGlobal('fetch', mockFetch('view'))

    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByText('View Only')).toBeInTheDocument()
    })
  })

  it('disables save button for view permission', async () => {
    vi.stubGlobal('fetch', mockFetch('view'))

    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>
    )

    await waitFor(() => {
      const saveBtn = screen.getByTitle('Save')
      expect(saveBtn).toBeDisabled()
    })
  })

  it('does not show View Only indicator for owner', async () => {
    vi.stubGlobal('fetch', mockFetch('owner'))

    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.queryByText('View Only')).not.toBeInTheDocument()
    })

    const saveBtn = screen.getByTitle('Save')
    expect(saveBtn).not.toBeDisabled()
  })

  it('does not show View Only indicator for edit permission', async () => {
    vi.stubGlobal('fetch', mockFetch('edit'))

    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.queryByText('View Only')).not.toBeInTheDocument()
    })

    const saveBtn = screen.getByTitle('Save')
    expect(saveBtn).not.toBeDisabled()
  })
})
