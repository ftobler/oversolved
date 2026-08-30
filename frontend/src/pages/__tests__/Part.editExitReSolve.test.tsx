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
 * This test inspects the solver payload after exit and asserts:
 *  - the full feature list (not a truncated slice) is sent
 *  - rollback_position reflects the restored end-of-stack
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { solveViaWorker } from '@/kernel/worker/solverClient'
import { Wrapper, partDocStoreMock } from '@/__tests__/test-utils'

vi.mock('@/kernel/worker/solverClient', () => ({
  solveViaWorker: vi.fn(),
  cancelSolver: vi.fn(),
}))

const solveMock = solveViaWorker as ReturnType<typeof vi.fn>

vi.mock('../../components/Viewport', () => ({
  default: vi.fn(() => null),
  __esModule: true,
}))

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

function allSolvePayloads(): Array<Record<string, unknown>> {
  return solveMock.mock.calls.map(c => c[0] as Record<string, unknown>)
}

describe('edit exit reSolve', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    usePartEditorStore.setState({ editingFeatureId: null, pickBoundary: null, rollbackPosition: null, ghostMode: false })
    solveMock.mockResolvedValue({ result: {}, bodies: {}, pick_bodies: {}, _build_state: null })
  })

  it('exiting edit on middle feature sends full feature list and end-of-stack rollback', async () => {
    partDocStoreMock({ content: FOUR_FEATURE_DOC })

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
    }, { timeout: 10000 })

    // Enter edit on Fillet 1 (middle feature)
    const editBtns = screen.getAllByTitle('Edit fillet')
    await act(async () => { fireEvent.click(editBtns[0]) })

    await waitFor(() => {
      const fil = screen.getByText('Fillet 1').closest('.feature-item')
      expect(fil?.classList.contains('editing')).toBe(true)
    }, { timeout: 10000 })

    const callsBeforeExit = solveMock.mock.calls.length

    // Exit edit
    await act(async () => { fireEvent.click(screen.getByTitle('OK')) })

    // Give pending microtasks (cache lookup, reSolve dispatch) a chance to flush.
    await new Promise(r => setTimeout(r, 50))

    const callsAfterExit = allSolvePayloads().slice(callsBeforeExit)

    // Guard against this regression protection going vacuous again: with a dead
    // mock (or an exit that never re-solves) there are no payloads to inspect.
    expect(callsAfterExit.length).toBeGreaterThan(0)

    // Any solve issued after exit must include the FULL feature list with ch1
    // present. The pre-fix bug produced a new solve with features truncated to
    // drop ch1 (rollback was the stale edit-mode idx+1). Asserting "no truncated
    // payload" catches that regression.
    for (const payload of callsAfterExit) {
      const features = (payload.features as Array<{ id: string }>) ?? []
      const featureIds = features.map(f => f.id)
      expect(featureIds).toContain('ch1')  // bug would drop ch1
      expect(featureIds).toContain('fil1')
      expect(featureIds).toContain('ex1')
    }

    // End-of-stack rollback on the last exit solve: the exit restored the bar to
    // null, which resolves to the full 4-feature stack, so rollback_position must
    // be 4. The pre-fix bug left the stale edit-mode idx+1 (3) here.
    const last = callsAfterExit[callsAfterExit.length - 1]
    const lastFeatures = (last.features as Array<{ id: string }>) ?? []
    expect(lastFeatures).toHaveLength(4)
    expect(last.rollback_position).toBe(4)
  })

  it('enter+exit on single-feature doc does not crash and pins the exit solve', async () => {
    partDocStoreMock({ content: SINGLE_FEATURE_DOC })

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
    }, { timeout: 10000 })

    // Enter edit on the sketch.
    await act(async () => { fireEvent.click(screen.getByTitle('Edit sketch')) })
    await waitFor(() => {
      expect(screen.getByTitle('OK')).toBeInTheDocument()
    }, { timeout: 10000 })

    const callsBeforeExit = solveMock.mock.calls.length

    // Exit edit
    await act(async () => { fireEvent.click(screen.getByTitle('OK')) })

    // The OK button disappearing is the edit actually closing.
    await waitFor(() => {
      expect(screen.queryByTitle('OK')).not.toBeInTheDocument()
    }, { timeout: 10000 })

    await new Promise(r => setTimeout(r, 50))

    const callsAfterExit = allSolvePayloads().slice(callsBeforeExit)
    expect(callsAfterExit.length).toBeGreaterThan(0)

    // Single-feature doc: test 1 is the truncation guard. Here the pre-fix stale
    // idx+1 equals the full count, so ['sk1']/rollback 1 cannot discriminate
    // truncation. This pins the enter+exit contract: exit still issues a solve
    // carrying sk1 with end-of-stack rollback (the full count, 1).
    const last = callsAfterExit[callsAfterExit.length - 1]
    const lastFeatures = (last.features as Array<{ id: string }>) ?? []
    expect(lastFeatures.map(f => f.id)).toEqual(['sk1'])
    expect(last.rollback_position).toBe(1)
  })
})
