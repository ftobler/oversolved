import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, fireEvent, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { forwardRef, useImperativeHandle } from 'react'
import Part from '@/pages/Part'
import { solverWs } from '@/hooks/solverWs'
import { invalidateAllCache } from '@/utils/buildCache'

vi.mock('../../hooks/solverWs', () => ({
  solverWs: {
    solve: vi.fn().mockResolvedValue({ result: {}, bodies: {}, pick_bodies: {}, _build_state: null }),
    disconnect: vi.fn(),
    onGeometryUpdate: vi.fn().mockReturnValue(() => {}),
  },
}))

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
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    await invalidateAllCache()
  })

  function mockFetch() {
    return vi.fn((url: string) => {
      if (url === '/api/auth/me') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ user: { id: 1, username: 'admin', must_change_password: false } }) } as Response)
      }
      if (url === '/api/documents/doc-1') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ uuid: 'doc-1', name: 'TestDoc', content: 'version: 1\nkind: part\nfeatures: []\n', permission: 'owner' }) } as Response)
      }
      return Promise.resolve({ ok: false, status: 404 } as Response)
    })
  }

  function countSolveCalls(): number {
    return (solverWs.solve as ReturnType<typeof vi.fn>).mock.calls.length
  }

  async function renderAndWaitForLoad() {
    mockFetch()
    vi.stubGlobal('fetch', mockFetch())

    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(countSolveCalls()).toBeGreaterThanOrEqual(1)
    })
  }

  it('adds extrude with exactly 1 solve', async () => {
    await renderAndWaitForLoad()
    vi.mocked(solverWs.solve).mockClear()

    fireEvent.click(screen.getByTitle('Feature mode'))
    fireEvent.click(screen.getByTitle('Add Extrude (E)'))

    await waitFor(() => {
      expect(countSolveCalls()).toBe(1)
    })
  })

  it('adds revolve with exactly 1 solve', async () => {
    await renderAndWaitForLoad()
    vi.mocked(solverWs.solve).mockClear()

    fireEvent.click(screen.getByTitle('Feature mode'))
    fireEvent.click(screen.getByTitle('Add Revolve'))

    await waitFor(() => {
      expect(countSolveCalls()).toBe(1)
    })
  })

  it('adds hole with exactly 1 solve', async () => {
    await renderAndWaitForLoad()
    vi.mocked(solverWs.solve).mockClear()

    fireEvent.click(screen.getByTitle('Feature mode'))
    fireEvent.click(screen.getByTitle('Add Hole'))

    await waitFor(() => {
      expect(countSolveCalls()).toBe(1)
    })
  })

  it('adds sketch with exactly 1 solve', async () => {
    await renderAndWaitForLoad()
    vi.mocked(solverWs.solve).mockClear()

    fireEvent.click(screen.getByTitle('Feature mode'))
    fireEvent.click(screen.getByTitle('Sketch'))

    await waitFor(() => {
      expect(countSolveCalls()).toBe(1)
    })
  })
})
