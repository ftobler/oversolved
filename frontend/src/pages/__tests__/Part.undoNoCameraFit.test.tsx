import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, act, fireEvent, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'
import { executeCommand } from '@/utils/core/commandRegistry'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { Wrapper, partDocStoreMock } from '@/__tests__/test-utils'

// `vi.hoisted`, because the mock factory below is hoisted above this line and
// reads the spies while building the module.
const mockAutoZoomToFit = vi.hoisted(() => vi.fn())
const mockCancelPendingFit = vi.hoisted(() => vi.fn())

// jsdom has no Worker, so the real worker client resolves null for any non-empty
// doc and the first solve (and its auto-zoom) never completes. Answer it with an
// empty build so onFirstSolve actually fires for a doc with features.
vi.mock('@/kernel/worker/solverClient', () => ({
  solveViaWorker: vi.fn().mockResolvedValue({ solve_ms: 0, result: {}, bodies: {}, _build_state: null }),
  cancelSolver: vi.fn(),
}))

vi.mock('../../components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule({
    autoZoomToFit: mockAutoZoomToFit,
    cancelPendingFit: mockCancelPendingFit,
  }))

const SKETCH_DOC = `version: 1
kind: part
features:
  - id: sk1
    kind: sketch
    label: Sketch 1
`

describe('Part - undo/redo never move the camera', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    partDocStoreMock()
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

  it('does not refit when the undo actually changes the document', async () => {
    // The empty-stack test above never pops an entry; this one drives a real
    // mutation so the undo restores a genuinely different doc.
    partDocStoreMock({ content: SKETCH_DOC })
    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>,
      { wrapper: Wrapper }
    )

    await waitFor(() => {
      expect(mockAutoZoomToFit).toHaveBeenCalledOnce()
    })
    mockAutoZoomToFit.mockClear()

    // Push one real undo entry: add an extrude and accept the dialog. The stack
    // (mirrored into the store by useSyncPartEditorStore) must actually carry an
    // entry, or the undo below pops nothing and the test proves no more than the
    // unconditional disarm already does.
    fireEvent.click(screen.getByTitle('Feature mode'))
    await act(async () => { fireEvent.click(screen.getByTitle('Add Extrude (E)')) })
    await act(async () => { fireEvent.click(screen.getByTitle('OK')) })
    expect(usePartEditorStore.getState().undoStack).toHaveLength(1)

    await act(async () => { executeCommand('undo') })
    expect(usePartEditorStore.getState().undoStack).toHaveLength(0)

    // The undo disarmed the pending fit and the doc swap re-solved without
    // re-framing: auto-zoom only ever fires for the first solve.
    expect(mockCancelPendingFit).toHaveBeenCalled()
    expect(mockAutoZoomToFit).not.toHaveBeenCalled()
  })
})
