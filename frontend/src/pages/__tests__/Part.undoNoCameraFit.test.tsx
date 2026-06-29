import React, { forwardRef, useImperativeHandle } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import { ToastProvider } from '@/contexts/ToastContext'
import Part from '@/pages/Part'
import { executeCommand } from '@/utils/core/commandRegistry'

const mockAutoZoomToFit = vi.fn()
const mockCancelPendingFit = vi.fn()

vi.mock('@/kernel/solveLocally', () => ({
  solveLocally: vi.fn().mockResolvedValue({ result: {}, bodies: {}, pick_bodies: {}, _build_state: null }),
}))

vi.mock('../../components/Viewport', () => ({
  default: forwardRef(function MockViewport(_props: Record<string, unknown>, ref) {
    useImperativeHandle(ref, () => ({
      autoZoomToFit: mockAutoZoomToFit,
      cancelPendingFit: mockCancelPendingFit,
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

function mockFetch() {
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
          permission: 'owner',
        }),
      } as Response)
    }
    return Promise.resolve({ ok: false, status: 404 } as Response)
  })
}

describe('Part - undo/redo never move the camera', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', mockFetch())
  })

  it('disarms any pending fit on undo/redo and does not re-fit', async () => {
    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>,
      { wrapper: Wrapper }
    )

    // First solve frames the document exactly once.
    await waitFor(() => {
      expect(mockAutoZoomToFit).toHaveBeenCalledOnce()
    })
    mockAutoZoomToFit.mockClear()

    // Undo and redo must disarm the pending fit and never reframe the camera,
    // even when their stacks are empty (the guarantee is unconditional).
    act(() => {
      executeCommand('undo')
      executeCommand('redo')
    })

    expect(mockCancelPendingFit).toHaveBeenCalledTimes(2)
    expect(mockAutoZoomToFit).not.toHaveBeenCalled()
  })
})
