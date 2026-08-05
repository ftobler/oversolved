import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'
import { solveViaWorker } from '@/kernel/worker/solverClient'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { Wrapper, partDocFetchMock } from '@/__tests__/test-utils'

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
// selectedPicks is "empty after a re-solve", but nothing implements that. This
// pins the CURRENT contract (the query AND its pick claims survive a real
// re-solve) so the contradiction is visible, and feature/
// selection-resolve-claim-invalidation updates it to the chosen contract when
// the fix lands. Note the pin only breaks under the plan's Option A (clear
// claims at the solve seam); under Option B (make stale claims inert in
// computeHighlight) the claims stay in the store and this test keeps passing.
describe('selection across a re-solve (pre-clearSelectedPicks contract)', () => {
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

  it('keeps the query and its pick claims when an edit enter/exit re-solves', async () => {
    vi.stubGlobal('fetch', partDocFetchMock({ content: SKETCH_DOC }))

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

    const solvesBeforeExit = solveMock.mock.calls.length
    fireEvent.click(screen.getByTitle('OK'))
    await waitFor(() => { expect(usePartEditorStore.getState().editingFeatureId).toBeNull() })
    // Let the commit's re-solve settle inside act so its UI updates are wrapped.
    await act(async () => { await new Promise(r => setTimeout(r, 50)) })
    expect(solveMock.mock.calls.length).toBeGreaterThan(solvesBeforeExit)

    const s = useSketchEditorStore.getState()
    expect(s.normalSelection.has('?02;ab:face')).toBe(true)
    expect(s.selectedPicks.get('?02;ab:face')).toEqual(new Set(['ex1/b0#face#0']))
  })
})
