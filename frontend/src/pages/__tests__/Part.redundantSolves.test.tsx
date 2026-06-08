import React, { forwardRef, useImperativeHandle } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, fireEvent, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import { ToastProvider } from '@/contexts/ToastContext'
import Part from '@/pages/Part'
import { solveViaWorker } from '@/kernel/worker/solverClient'
import { invalidateAllCache } from '@/utils/buildCache'

vi.mock('@/kernel/worker/solverClient', () => ({
  solveViaWorker: vi.fn().mockResolvedValue({ result: {}, bodies: {}, pick_bodies: {}, _build_state: null }),
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

const theme = createTheme()
function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <ToastProvider>{children}</ToastProvider>
    </ThemeProvider>
  )
}

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
    return (solveViaWorker as ReturnType<typeof vi.fn>).mock.calls.length
  }

  async function renderAndWaitForLoad() {
    mockFetch()
    vi.stubGlobal('fetch', mockFetch())

    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>,
      { wrapper: Wrapper }
    )

    // The doc loads empty (features: []), which needs no solve, so wait for the
    // toolbar to mount rather than for a solve call.
    await screen.findByTitle('Feature mode')
  }

  it('adds extrude with exactly 1 solve', async () => {
    await renderAndWaitForLoad()
    vi.mocked(solveViaWorker).mockClear()

    fireEvent.click(screen.getByTitle('Feature mode'))
    fireEvent.click(screen.getByTitle('Add Extrude (E)'))

    await waitFor(() => {
      expect(countSolveCalls()).toBe(1)
    })
  })

  it('adds revolve with exactly 1 solve', async () => {
    await renderAndWaitForLoad()
    vi.mocked(solveViaWorker).mockClear()

    fireEvent.click(screen.getByTitle('Feature mode'))
    fireEvent.click(screen.getByTitle('Add Revolve'))

    await waitFor(() => {
      expect(countSolveCalls()).toBe(1)
    })
  })

  it('adds hole with exactly 1 solve', async () => {
    await renderAndWaitForLoad()
    vi.mocked(solveViaWorker).mockClear()

    fireEvent.click(screen.getByTitle('Feature mode'))
    fireEvent.click(screen.getByTitle('Add Hole'))

    await waitFor(() => {
      expect(countSolveCalls()).toBe(1)
    })
  })

  it('adds sketch with exactly 2 solves (add + auto-enter-edit preview)', async () => {
    await renderAndWaitForLoad()
    vi.mocked(solveViaWorker).mockClear()

    fireEvent.click(screen.getByTitle('Feature mode'))
    fireEvent.click(screen.getByTitle('Sketch'))

    // Adding a sketch also auto-enters sketch edit, which fires a second
    // (preview) solve. Previously the IndexedDB build cache short-circuited
    // that second solve before it reached the backend; with the cache removed
    // it now runs through the local kernel (fast, checkpoint-cached).
    await waitFor(() => {
      expect(countSolveCalls()).toBe(2)
    })
  })

  it('adds extrude then sketch with exactly 2 total solves', async () => {
    await renderAndWaitForLoad()
    vi.mocked(solveViaWorker).mockClear()

    fireEvent.click(screen.getByTitle('Feature mode'))
    fireEvent.click(screen.getByTitle('Add Extrude (E)'))

    await waitFor(() => {
      expect(countSolveCalls()).toBe(1)
    })

    fireEvent.click(screen.getByTitle('Sketch'))

    await waitFor(() => {
      expect(countSolveCalls()).toBe(2)
    })
  })

  it('user rollback change triggers exactly 1 solve', async () => {
    await renderAndWaitForLoad()
    vi.mocked(solveViaWorker).mockClear()

    fireEvent.click(screen.getByTitle('Feature mode'))
    fireEvent.click(screen.getByTitle('Add Extrude (E)'))

    await waitFor(() => {
      expect(countSolveCalls()).toBe(1)
    })

    vi.mocked(solveViaWorker).mockClear()

    const rollbackBars = screen.getAllByTitle('Rollback')
    const lastBar = rollbackBars[rollbackBars.length - 1]

    const dragStartEvent = new MouseEvent('dragstart', { bubbles: true, cancelable: true })
    Object.defineProperty(dragStartEvent, 'dataTransfer', {
      value: { effectAllowed: '', setData: vi.fn(), getData: vi.fn() },
      configurable: true,
    })
    fireEvent(lastBar, dragStartEvent)

    const dropEvent = new MouseEvent('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(dropEvent, 'dataTransfer', {
      value: { effectAllowed: '', setData: vi.fn(), getData: vi.fn() },
      configurable: true,
    })
    fireEvent(lastBar, dropEvent)

    await waitFor(() => {
      expect(countSolveCalls()).toBe(1)
    })
  })
})
