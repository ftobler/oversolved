/**
 * Regression test: entering and exiting edit mode on a non-last feature must
 * restore the rollback position to the full stack so that features after it
 * are re-solved on exit.
 *
 * Bug: exitEditFeature compared rollbackPosition against savedRollbackPosition
 * (the pre-edit full-stack position), but enterEditFeature had already set
 * rollbackPosition to idx+1. For any feature except the last, idx+1 !=
 * savedRollbackPosition so the condition was always false and the rollback
 * was never restored -- features after the edited one disappeared.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import { ToastProvider } from '@/contexts/ToastContext'
import Part from '@/pages/Part'

vi.mock('../../hooks/solverWs', () => ({
  solverWs: {
    solve: vi.fn().mockResolvedValue({ result: {}, bodies: {}, pick_bodies: {}, _build_state: null }),
    disconnect: vi.fn(),
    onGeometryUpdate: vi.fn().mockReturnValue(() => {}),
  },
}))

vi.mock('../../components/Viewport', () => ({
  default: vi.fn(() => null),
  __esModule: true,
}))

function makeDoc(content: string) {
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
        json: () => Promise.resolve({ uuid: 'doc-1', name: 'TestDoc', content, permission: 'owner' }),
      } as Response)
    }
    return Promise.resolve({ ok: false, status: 404 } as Response)
  })
}

const TWO_FILLETS_DOC = `version: 1
kind: part
features:
  - id: sk1
    kind: sketch
    label: Sketch 1
  - id: ex1
    kind: extrude
    label: Extrude 1
    extrude: { sketch: '$sk1', distance: 10, direction: 'normal' }
  - id: fil1
    kind: fillet
    label: Fillet 1
    edges: []
    radius: 1
  - id: fil2
    kind: fillet
    label: Fillet 2
    edges: []
    radius: 2
`

const theme = createTheme()
function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <ToastProvider>{children}</ToastProvider>
    </ThemeProvider>
  )
}

describe('feature edit rollback restore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rollback bar returns to end after exiting edit mode on non-last feature', async () => {
    vi.stubGlobal('fetch', makeDoc(TWO_FILLETS_DOC))

    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>,
      { wrapper: Wrapper }
    )

    await waitFor(() => {
      expect(screen.getByText('Fillet 1')).toBeInTheDocument()
      expect(screen.getByText('Fillet 2')).toBeInTheDocument()
    })

    // Rollback bar starts at the end (after Fillet 2, no feature is rolled back)
    await waitFor(() => {
      expect(screen.queryByTitle('Rollback')).toBeInTheDocument()
    })
    const filletItems = screen.getAllByTitle('Rollback')
    expect(filletItems.length).toBeGreaterThan(0)

    // Enter edit mode on Fillet 1 (not the last feature)
    const editBtns = screen.getAllByTitle('Edit fillet')
    fireEvent.click(editBtns[0])

    // Fillet 2 should now be rolled back (grayed out)
    await waitFor(() => {
      const fil2 = screen.getByText('Fillet 2').closest('.feature-item')
      expect(fil2?.classList.contains('rolled-back')).toBe(true)
    })

    // Exit edit mode on Fillet 1
    fireEvent.click(screen.getByTitle('Exit fillet editor'))

    // Fillet 2 must no longer be rolled back -- rollback is restored to full stack
    await waitFor(() => {
      const fil2 = screen.getByText('Fillet 2').closest('.feature-item')
      expect(fil2?.classList.contains('rolled-back')).toBe(false)
    })
  })

  it('editing the last feature and exiting also restores correctly', async () => {
    vi.stubGlobal('fetch', makeDoc(TWO_FILLETS_DOC))

    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>,
      { wrapper: Wrapper }
    )

    await waitFor(() => {
      expect(screen.getByText('Fillet 2')).toBeInTheDocument()
    })

    // Enter edit mode on Fillet 2 (the last feature)
    const editBtns = screen.getAllByTitle('Edit fillet')
    fireEvent.click(editBtns[editBtns.length - 1])

    // Fillet 2 itself is now in edit mode -- nothing after it to roll back
    await waitFor(() => {
      const fil2 = screen.getByText('Fillet 2').closest('.feature-item')
      expect(fil2?.classList.contains('editing')).toBe(true)
    })

    // Exit
    fireEvent.click(screen.getByTitle('Exit fillet editor'))

    // Everything still visible and not rolled back
    await waitFor(() => {
      const fil1 = screen.getByText('Fillet 1').closest('.feature-item')
      const fil2 = screen.getByText('Fillet 2').closest('.feature-item')
      expect(fil1?.classList.contains('rolled-back')).toBe(false)
      expect(fil2?.classList.contains('rolled-back')).toBe(false)
    })
  })
})
