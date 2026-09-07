import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'
import { solveViaWorker } from '@/kernel/worker/solverClient'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { Wrapper, partDocStoreMock } from '@/__tests__/test-utils'

vi.mock('@/kernel/worker/solverClient', () => ({
  solveViaWorker: vi.fn().mockResolvedValue({ result: {}, bodies: {}, pick_bodies: {}, _build_state: null }),
}))

vi.mock('../../components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule())

const solveMock = solveViaWorker as ReturnType<typeof vi.fn>

const SKETCH_DOC = `version: 1
kind: part
features:
  - id: sk1
    kind: sketch
    label: Sketch 1
  - id: ex1
    kind: extrude
    label: Extrude 1
    extrude: { sketch: '$sk1', distance: 10, direction: 'normal' }
`

// Re-solve survival: the store comment at sketchEditorStore.ts:244-245 promises
// selectedPicks is "empty after a re-solve". This pins the Option A contract:
// every applied solve clears the per-primitive pick claims at the write-back
// seam (useSolver applySolveResult -> clearSelectedPicks) while the durable
// query selection survives, so computeHighlight re-highlights by query
// membership. A stale positional claim must never survive a re-tessellation.
// The sketch entry is the re-solve this straddles: leaving the sketch is a
// context change that retires the whole selection subsystem, so the survival
// half has to be read before the exit and the exit is asserted for what it is.
describe('selection across a re-solve (clearSelectedPicks contract)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    useSketchEditorStore.setState({
      normalSelection: new Set(),
      selectedPicks: new Map(),
      chipOwnedSelection: new Set(),
      activePickField: null,
      modeStack: [],
      activeFeatureId: null,
    })
    usePartEditorStore.setState({ editingFeatureId: null })
  })

  it('clears the pick claims but keeps the query across an edit-enter re-solve', async () => {
    partDocStoreMock({ content: SKETCH_DOC })

    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>,
      { wrapper: Wrapper }
    )
    await screen.findByTitle('Feature mode')
    await waitFor(() => { expect(solveMock.mock.calls.length).toBeGreaterThanOrEqual(1) })

    // A viewport click minted this claim via the dispatcher. No pick field is
    // armed (idle select), so nothing can consume the selection out of the way.
    act(() => {
      useSketchEditorStore.getState().toggleNormalSelection('?02;ab:face', 'ex1/b0#face#0')
    })

    // Entering the sketch edit re-solves, and exiting it re-solves again; both
    // solve counts must advance so the assertions really straddle a re-solve.
    const solvesBeforeEnter = solveMock.mock.calls.length
    fireEvent.click(screen.getByTitle('Edit sketch'))
    await waitFor(() => { expect(usePartEditorStore.getState().editingFeatureId).toBe('sk1') })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })  // flush the enter's solve
    expect(solveMock.mock.calls.length).toBeGreaterThan(solvesBeforeEnter)

    const afterEnter = useSketchEditorStore.getState()
    expect(afterEnter.normalSelection.has('?02;ab:face')).toBe(true)
    expect(afterEnter.selectedPicks.size).toBe(0)

    const solvesBeforeExit = solveMock.mock.calls.length
    fireEvent.click(screen.getByTitle('OK'))
    await waitFor(() => { expect(usePartEditorStore.getState().editingFeatureId).toBeNull() })
    // Let the commit's re-solve settle inside act so its UI updates are wrapped.
    await act(async () => { await new Promise(r => setTimeout(r, 50)) })
    expect(solveMock.mock.calls.length).toBeGreaterThan(solvesBeforeExit)

    // Leaving the sketch is not a re-solve question: setActiveFeatureId retires
    // the selection wholesale so a sketch-scoped query cannot outlive its sketch.
    expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
  })
})
