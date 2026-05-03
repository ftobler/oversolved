import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, fireEvent, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { forwardRef, useImperativeHandle } from 'react'
import Part from '../Part'

vi.mock('../../components/Viewport', () => ({
  default: forwardRef(function MockViewport(_props: Record<string, unknown>, ref) {
    useImperativeHandle(ref, () => ({
      autoZoomToFit: vi.fn(),
      captureScreenshot: vi.fn(),
      captureScreenshotForSaving: vi.fn(),
      alignCameraToPlane: vi.fn(),
      alignCameraToFace: vi.fn(),
    }))
    return null
  }),
  __esModule: true,
}))

describe('Part - eliminate redundant solves', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function mockFetch() {
    return vi.fn((url: string) => {
      if (url === '/api/auth/me') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ user: { id: 1, username: 'admin', must_change_password: false } }) } as Response)
      }
      if (url === '/api/documents/doc-1') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ uuid: 'doc-1', name: 'TestDoc', content: 'version: 1\nkind: part\nfeatures: []\n', permission: 'owner' }) } as Response)
      }
      if (url === '/api/solve') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ result: {}, bodies: {}, pick_bodies: {}, _build_state: null }) } as Response)
      }
      return Promise.resolve({ ok: false, status: 404 } as Response)
    })
  }

  function countSolveCalls(fetchMock: ReturnType<typeof vi.fn>): number {
    return fetchMock.mock.calls.filter(c => c[0] === '/api/solve').length
  }

  async function renderAndWaitForLoad() {
    const fetchMock = mockFetch()
    vi.stubGlobal('fetch', fetchMock)

    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(countSolveCalls(fetchMock)).toBeGreaterThanOrEqual(1)
    })

    return fetchMock
  }

  it('adds extrude with exactly 1 solve', async () => {
    const fetchMock = await renderAndWaitForLoad()
    fetchMock.mockClear()

    fireEvent.click(screen.getByTitle('Feature mode'))
    fireEvent.click(screen.getByTitle('Add Extrude (E)'))

    await waitFor(() => {
      expect(countSolveCalls(fetchMock)).toBe(1)
    })
  })

  it('adds revolve with exactly 1 solve', async () => {
    const fetchMock = await renderAndWaitForLoad()
    fetchMock.mockClear()

    fireEvent.click(screen.getByTitle('Feature mode'))
    fireEvent.click(screen.getByTitle('Add Revolve'))

    await waitFor(() => {
      expect(countSolveCalls(fetchMock)).toBe(1)
    })
  })

  it('adds hole with exactly 1 solve', async () => {
    const fetchMock = await renderAndWaitForLoad()
    fetchMock.mockClear()

    fireEvent.click(screen.getByTitle('Feature mode'))
    fireEvent.click(screen.getByTitle('Add Hole'))

    await waitFor(() => {
      expect(countSolveCalls(fetchMock)).toBe(1)
    })
  })

  it('adds sketch with exactly 1 solve', async () => {
    const fetchMock = await renderAndWaitForLoad()
    fetchMock.mockClear()

    fireEvent.click(screen.getByTitle('Feature mode'))
    fireEvent.click(screen.getByTitle('Sketch'))

    await waitFor(() => {
      expect(countSolveCalls(fetchMock)).toBe(1)
    })
  })
})
