/**
 * Ctrl+Z over an in-progress draw gesture must cancel just the half-placed
 * entity (the same thing the first Escape does) WITHOUT popping a real history
 * entry. Without the first stage, one keystroke both discards the draw point and
 * pops history: two changes from one press. A second Ctrl+Z, with nothing left
 * in progress, pops the entry as before.
 *
 * Uses the real usePartDoc and undo stack, because the defect is only visible in
 * the composition of the command's gesture guard and the real applyUndoRedo.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'
import { executeCommand } from '@/utils/core/commandRegistry'
import { useSketchEditorStore, useSketchUiStore } from '@/stores/sketchEditorStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { Wrapper, partDocStoreMock } from '@/__tests__/test-utils'
import { initializeTools } from '@/tools'
import { useEditorState } from '@/hooks/useEditorState'

// undo drives cancelPendingFit, so the mock must provide it.
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
    { wrapper: Wrapper }
  )
}

describe('Part - undo first stage cancels an in-progress gesture', () => {
  // The gesture guard cancels via the store's clearDraw, whose mode-stack
  // coupling is only valid against a live tool registry.
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
  })
  useSketchUiStore.setState({
    pendingDialog: null,
  })
  })

  it('cancels the draw without popping, then a second undo pops the entry', async () => {
    partDocStoreMock({ content: SKETCH_DOC })
    renderPart()
    await screen.findByTitle('Feature mode')
    fireEvent.click(screen.getByTitle('Feature mode'))

    // Seed one real entry so there is something to pop past the first press.
    await act(async () => { executeCommand('toggle_sketch_plane_visibility') })
    const seeded = usePartEditorStore.getState().undoStack.length
    expect(seeded).toBeGreaterThan(0)

    // A half-placed line: one point drawn under the armed tool, no entity committed.
    useSketchEditorStore.getState().setActiveTool('line')
    act(() => { useEditorState.setState({
    drawPoints: [[0, 0]],
  }) })

    // First Ctrl+Z cancels the gesture and leaves history untouched: no entry
    // moves to redo, so the stack is byte-for-byte what it was.
    await act(async () => { executeCommand('undo') })
    expect(useSketchEditorStore.getState().drawPoints).toEqual([])
    expect(usePartEditorStore.getState().undoStack.length).toBe(seeded)
    expect(usePartEditorStore.getState().redoStack.length).toBe(0)

    // Second Ctrl+Z: nothing in progress, so it pops the real entry as before.
    await act(async () => { executeCommand('undo') })
    await waitFor(() => expect(usePartEditorStore.getState().undoStack.length).toBe(seeded - 1))
    expect(usePartEditorStore.getState().redoStack.length).toBe(1)
  })
})
