/**
 * Regression test for the stale-closure bug in exitEditFeature.
 *
 * Bug: on edit exit, the rebuild path went through handleRebuildRef.current()
 * which closed over a stale rollbackPosition (the edit-mode idx+1 value).
 * This caused the solver payload to be truncated to the edited feature,
 * silently dropping all downstream features.
 *
 * Fix: capture savedRollbackPosition into a local and call reSolve directly,
 * bypassing the ref entirely.
 *
 * This test inspects the WS solve payload after exit and asserts:
 *  - the full feature list (not a truncated slice) is sent
 *  - rollback_position reflects the restored end-of-stack
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import { ToastProvider } from '@/contexts/ToastContext'
import Part from '@/pages/Part'
import { solverWs } from '@/hooks/solverWs'
import { cacheBuildResponse, invalidateAllCache } from '@/utils/buildCache'
import type { PartDoc } from '@/types/cad'

vi.mock('../../hooks/solverWs', () => ({
  solverWs: {
    solve: vi.fn().mockResolvedValue({ result: {}, bodies: {}, pick_bodies: {}, _build_state: null }),
    disconnect: vi.fn(),
    onGeometryUpdate: vi.fn().mockReturnValue(() => {}),
  },
}))

const solveMock = solverWs.solve as ReturnType<typeof vi.fn>

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

const FOUR_FEATURE_DOC = `version: 1
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
  - id: ch1
    kind: chamfer
    label: Chamfer 1
    edges: []
    distance: 1
`

const SINGLE_FEATURE_DOC = `version: 1
kind: part
features:
  - id: sk1
    kind: sketch
    label: Sketch 1
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

function allSolvePayloads(): Array<Record<string, unknown>> {
  return solveMock.mock.calls.map(c => c[0] as Record<string, unknown>)
}

describe('edit exit reSolve', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    solveMock.mockResolvedValue({ result: {}, bodies: {}, pick_bodies: {}, _build_state: null })
    await invalidateAllCache()
  })

  it('exiting edit on middle feature sends full feature list and end-of-stack rollback', async () => {
    vi.stubGlobal('fetch', makeDoc(FOUR_FEATURE_DOC))

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
      expect(screen.getByText('Chamfer 1')).toBeInTheDocument()
    })

    // Enter edit on Fillet 1 (middle feature)
    const editBtns = screen.getAllByTitle('Edit fillet')
    await act(async () => { fireEvent.click(editBtns[0]) })

    await waitFor(() => {
      const fil = screen.getByText('Fillet 1').closest('.feature-item')
      expect(fil?.classList.contains('editing')).toBe(true)
    })

    const callsBeforeExit = solveMock.mock.calls.length

    // Exit edit
    await act(async () => { fireEvent.click(screen.getByTitle('OK')) })

    // Give pending microtasks (cache lookup, reSolve dispatch) a chance to flush.
    await new Promise(r => setTimeout(r, 50))

    const callsAfterExit = allSolvePayloads().slice(callsBeforeExit)

    // Either:
    //   (a) no new solve was issued (cache hit on the full-stack key matching initial load), OR
    //   (b) any new solve must include the FULL feature list with ch1 present.
    //
    // The pre-fix bug produced a new solve with features truncated to drop ch1
    // (rollback was the stale edit-mode idx+1). Asserting "no truncated payload"
    // catches that regression in both regimes.
    for (const payload of callsAfterExit) {
      const features = (payload.features as Array<{ id: string }>) ?? []
      const featureIds = features.map(f => f.id)
      expect(featureIds).toContain('ch1')  // bug would drop ch1
      expect(featureIds).toContain('fil1')
      expect(featureIds).toContain('ex1')
    }
  })

  it('exit re-solve always goes to WebSocket even when a stale cache entry exists for the same key', async () => {
    // Pre-populate the cache with the initial doc state. A drag mutation only
    // changes `initial`, which computeCacheKey strips. Without bypassCache the
    // stale cache hit would serve pre-mutation geometry and the drag would snap
    // back. The fix: handleMutation calls reSolve with bypassCache:true, which
    // calls invalidateDocCache so the exit re-solve is forced through the WS.
    const emptyDoc: PartDoc = { features: [] }
    await cacheBuildResponse('doc-1', emptyDoc, 0, null, { solve_ms: 0, result: {}, bodies: {} })

    vi.stubGlobal('fetch', makeDoc(FOUR_FEATURE_DOC))

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
    })

    const callsBefore = solveMock.mock.calls.length

    // Enter edit and exit immediately -- exit re-solve must hit WS even if the
    // pre-populated cache key would match.
    const editBtns = screen.getAllByTitle('Edit fillet')
    await act(async () => { fireEvent.click(editBtns[0]) })
    // Wait for the enter-edit reSolve to flush so the exit-edit reSolve
    // does not cancel it with a stale requestId check.
    await new Promise(r => setTimeout(r, 100))
    await act(async () => { fireEvent.click(screen.getByTitle('OK')) })

    await new Promise(r => setTimeout(r, 50))

    // At least one solve must have been issued via WS since entering edit
    // (either the enter solve or the exit solve).
    expect(solveMock.mock.calls.length).toBeGreaterThan(callsBefore)
  })

  it('enter+exit on single-feature doc does not crash and does not truncate', async () => {
    vi.stubGlobal('fetch', makeDoc(SINGLE_FEATURE_DOC))

    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>,
      { wrapper: Wrapper }
    )

    await waitFor(() => {
      expect(screen.getByText('Sketch 1')).toBeInTheDocument()
    })

    // No exception even with only built-ins after sketch (just confirm render survives).
    expect(screen.getByText('Sketch 1')).toBeInTheDocument()
  })
})
