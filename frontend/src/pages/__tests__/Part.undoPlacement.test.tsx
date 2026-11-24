/**
 * Toolbar undo while a placement prompt is open. The session cancels the open
 * placement transaction, but that path emits neither `historyRestored` nor
 * `transactionsDropped`, so the store would keep its pending id and the dialog
 * alive against a constraint the rewind removed. The undo command resolves the
 * gesture through the same cancel a tool switch uses and stops there: one press
 * does one thing, and the history stack does not move.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'
import { executeCommand } from '@/hooks/commandRegistry'
import { useSketchEditorStore, useSketchUiStore } from '@/stores/sketchEditorStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { Wrapper, partDocStoreMock } from '@/__tests__/test-utils'
import { initializeTools } from '@/tools'
import { useEditorState } from '@/hooks/useEditorState'

vi.mock('../../components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule({ cancelPendingFit: vi.fn() }))

const SKETCH_DOC = `version: 1
kind: part
features:
  - id: sk1
    kind: sketch
    label: Sketch 1
`

function renderPart() {
  return render(
    <MemoryRouter initialEntries={['/documents/doc-1']}>
      <Routes>
        <Route path="/documents/:uuid" element={<Part />} />
      </Routes>
    </MemoryRouter>,
    { wrapper: Wrapper },
  )
}

describe('Part - toolbar undo resolves an open placement prompt', () => {
  beforeAll(() => { initializeTools() })

  beforeEach(() => {
    vi.clearAllMocks()
    useSketchEditorStore.getState().setActiveTool(null)
    useEditorState.setState({
      normalSelection: new Set(),
      activePickField: null,
      modeStack: [],
      drawPoints: [],
      dimensionPicks: [],
      pendingBrepProjectionIds: [],
      pendingPlacementConstraintId: null,
    })
    useSketchUiStore.setState({ pendingDialog: null })
  })

  it('cancels the placement without popping, then a second undo pops the entry', async () => {
    partDocStoreMock({ content: SKETCH_DOC })
    renderPart()
    await screen.findByTitle('Feature mode')
    fireEvent.click(screen.getByTitle('Feature mode'))

    // One real entry behind the gesture, so a pop would be observable.
    await act(async () => { executeCommand('toggle_sketch_plane_visibility') })
    const seeded = usePartEditorStore.getState().undoStack.length
    expect(seeded).toBeGreaterThan(0)

    // The freshly inserted dimension's prompt is up.
    act(() => {
      useSketchEditorStore.setState({
        pendingPlacementConstraintId: 'c_len_1',
        pendingBrepProjectionIds: [],
      })
      useSketchUiStore.setState({
        pendingDialog: {
          position: [10, 10],
          label: 'dimension',
          defaultValue: '10',
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
        },
      })
    })

    await act(async () => { executeCommand('undo') })

    // The store and the prompt came down with the gesture; no entry moved.
    expect(useSketchEditorStore.getState().pendingPlacementConstraintId).toBeNull()
    expect(useSketchUiStore.getState().pendingDialog).toBeNull()
    expect(usePartEditorStore.getState().undoStack.length).toBe(seeded)
    expect(usePartEditorStore.getState().redoStack.length).toBe(0)

    // Nothing in progress now, so the next press pops the real entry.
    await act(async () => { executeCommand('undo') })
    await waitFor(() => expect(usePartEditorStore.getState().undoStack.length).toBe(seeded - 1))
    expect(usePartEditorStore.getState().redoStack.length).toBe(1)
  })
})
