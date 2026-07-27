/**
 * Entering a feature edit turns on the ghost preview (solid "before" bodies plus
 * a violet overlay of what the edit adds). Both halves come from the solve that
 * carries the pick bodies, so ghost mode must wait for it: while that solve is
 * in flight there is no "before" state, the overlay has nothing to subtract, and
 * the whole model flashes as violet wireframe.
 */
import React, { forwardRef, useImperativeHandle } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import { ToastProvider } from '@/contexts/ToastContext'
import Part from '@/pages/Part'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { solveViaWorker } from '@/kernel/worker/solverClient'

vi.mock('@/kernel/worker/solverClient', () => ({
  solveViaWorker: vi.fn(),
  cancelSolver: vi.fn(),
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

const DOC = `version: 1
kind: part
features:
  - id: sk1
    kind: sketch
    label: Sketch 1
  - id: ex1
    kind: extrude
    label: Extrude 1
    extrude: { sketch: '$sk1', distance: 10, direction: 'normal' }
  - id: db1
    kind: delete_body
    label: Delete Body 1
    delete_body: { bodies: [] }
`

const BODIES = { body_ex1: { id: 'body_ex1', created_by: 'ex1', modified_by: [], mesh: { vertices: [], faces: [] } } }

function mockFetch() {
  return vi.fn((url: string) => {
    if (url === '/api/auth/me') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ user: { id: 1, username: 'admin', must_change_password: false } }) } as Response)
    }
    if (url === '/api/documents/doc-1') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ uuid: 'doc-1', name: 'TestDoc', content: DOC, permission: 'owner' }) } as Response)
    }
    return Promise.resolve({ ok: false, status: 404 } as Response)
  })
}

const theme = createTheme()
function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <ToastProvider>{children}</ToastProvider>
    </ThemeProvider>
  )
}

describe('delete_body ghost preview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    usePartEditorStore.setState({ editingFeatureId: null, pickBoundary: null, rollbackPosition: null, ghostMode: false })
  })

  it('turns ghost mode on only once the pick bodies land', async () => {
    // The edit solve (the one asking for a pick boundary) is held open so the
    // in-flight window is observable.
    let releaseEditSolve!: (v: unknown) => void
    const editSolve = new Promise(r => { releaseEditSolve = r })
    const mock = solveViaWorker as ReturnType<typeof vi.fn>
    mock.mockImplementation((_payload: unknown, opts?: { pickBoundary?: number | null }) =>
      opts?.pickBoundary != null
        ? editSolve
        : Promise.resolve({ result: {}, bodies: BODIES, _build_state: null }),
    )
    vi.stubGlobal('fetch', mockFetch())

    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>,
      { wrapper: Wrapper }
    )

    const editBtn = await screen.findByTitle('Edit delete body')
    fireEvent.click(editBtn)

    await waitFor(() => expect(usePartEditorStore.getState().pickBoundary).not.toBeNull())
    expect(usePartEditorStore.getState().ghostMode).toBe(false)

    releaseEditSolve({ result: {}, bodies: {}, pick_bodies: BODIES, _build_state: null })
    await waitFor(() => expect(usePartEditorStore.getState().ghostMode).toBe(true))
    expect(usePartEditorStore.getState().pickBodies).toEqual(BODIES)
    // The delete emptied the body store, so the ghosts are all that is left.
    expect(usePartEditorStore.getState().bodies).toEqual({})
  })
})
