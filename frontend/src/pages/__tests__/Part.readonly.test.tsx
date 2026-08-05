import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'
import { Wrapper, partDocFetchMock } from '@/__tests__/test-utils'

vi.mock('../../components/Viewport', () => ({
  default: vi.fn(() => null),
  __esModule: true,
}))

describe('Part read-only mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows View Only indicator for view permission', async () => {
    vi.stubGlobal('fetch', partDocFetchMock({ permission: 'view' }))

    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>,
      { wrapper: Wrapper }
    )

    await waitFor(() => {
      expect(screen.getByText('View Only')).toBeInTheDocument()
    })
  })

  it('disables save button for view permission', async () => {
    vi.stubGlobal('fetch', partDocFetchMock({ permission: 'view' }))

    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>,
      { wrapper: Wrapper }
    )

    await waitFor(() => {
      const saveBtn = screen.getByTitle('Save')
      expect(saveBtn).toBeDisabled()
    })
  })

  it('does not show View Only indicator for owner', async () => {
    vi.stubGlobal('fetch', partDocFetchMock({ permission: 'owner' }))

    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>,
      { wrapper: Wrapper }
    )

    await waitFor(() => {
      expect(screen.queryByText('View Only')).not.toBeInTheDocument()
    })

    const saveBtn = screen.getByTitle('Save')
    expect(saveBtn).not.toBeDisabled()
  })

  it('does not show View Only indicator for edit permission', async () => {
    vi.stubGlobal('fetch', partDocFetchMock({ permission: 'edit' }))

    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>,
      { wrapper: Wrapper }
    )

    await waitFor(() => {
      expect(screen.queryByText('View Only')).not.toBeInTheDocument()
    })

    const saveBtn = screen.getByTitle('Save')
    expect(saveBtn).not.toBeDisabled()
  })
})
