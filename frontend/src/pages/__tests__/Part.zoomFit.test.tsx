import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'
import { Wrapper, partDocStoreMock } from '@/__tests__/test-utils'

// `vi.hoisted`, because the mock factory below is hoisted above this line and
// reads the spy while building the module (the old inline mock got away with a
// plain const only by deferring the read to render time).
const mockAutoZoomToFit = vi.hoisted(() => vi.fn())

vi.mock('../../components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule({ autoZoomToFit: mockAutoZoomToFit }))

describe('Part - zoom to fit on open', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should call autoZoomToFit after first solve', async () => {
    partDocStoreMock()

    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>,
      { wrapper: Wrapper }
    )

    await waitFor(() => {
      expect(mockAutoZoomToFit).toHaveBeenCalledOnce()
    })
  })
})
