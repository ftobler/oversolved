/**
 * Ctrl+Z inside an open sketch undoes the sketch action and keeps the sketch
 * open, in Sketch mode, with the armed tool still armed. The engine decides the
 * session survives (session/__tests__/undoEngine.test.ts); this page row pins
 * what the user sees: no exit to Feature mode, and the transient editor chrome
 * that named the pre-undo content is gone.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react'
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
    { wrapper: Wrapper }
  )
}

describe('Part - undo inside a sketch keeps the sketch open', () => {
  beforeAll(() => { initializeTools() })

  beforeEach(() => {
    vi.clearAllMocks()
    useSketchEditorStore.getState().setActiveTool(null)
    useEditorState.setState({
      normalSelection: new Set(),
      hoveredSelectionId: null,
      activePickField: null,
      modeStack: [],
      drawPoints: [],
      dimensionPicks: [],
    })
    useSketchUiStore.setState({ pendingDialog: null })
  })

  it('stays in Sketch mode and drops the stale editor chrome', async () => {
    partDocStoreMock({ content: SKETCH_DOC })
    renderPart()
    await screen.findByTitle('Feature mode')
    fireEvent.click(screen.getByTitle('Feature mode'))

    await waitFor(() => expect(screen.getByText('Sketch 1')).toBeInTheDocument())
    fireEvent.click(screen.getByTitle('Edit sketch'))
    await waitFor(() => expect(useEditorState.getState().editingFeatureId).toBe('sk1'))
    expect(screen.getByTitle('Sketch mode').className).toContain('active')

    // One real sketch action to undo.
    await act(async () => { executeCommand('toggle_sketch_plane_visibility') })
    const seeded = usePartEditorStore.getState().undoStack.length
    expect(seeded).toBeGreaterThan(0)

    // Transient editor state that names the pre-undo world: a selection, a
    // hover, an open value dialog and the row's context menu. The armed tool is
    // part of the session the user is still in, so it must survive.
    await act(async () => {
      useSketchEditorStore.getState().setActiveTool('line')
      useEditorState.getState().setNormalSelection(new Set(['entity:sk1:l1']))
      useEditorState.getState().setHoveredSelectionId('entity:sk1:l1')
      useSketchUiStore.getState().openDialog({
        position: [0, 0],
        label: 'Length',
        onConfirm: () => {},
      })
    })
    const sketchRow = screen.getAllByText('Sketch 1')
      .map(node => node.closest('.feature-item'))
      .find((node): node is HTMLElement => node !== null)
    expect(sketchRow).toBeDefined()
    fireEvent.click(within(sketchRow as HTMLElement).getByTitle('More options'))
    expect(screen.queryByRole('menu')).not.toBeNull()

    await act(async () => { executeCommand('undo') })

    await waitFor(() => expect(usePartEditorStore.getState().undoStack.length).toBe(seeded - 1))
    expect(useEditorState.getState().editingFeatureId).toBe('sk1')
    expect(screen.getByTitle('Sketch mode').className).toContain('active')

    const store = useSketchEditorStore.getState()
    expect(store.normalSelection.size).toBe(0)
    expect(store.hoveredSelectionId).toBeNull()
    expect(useSketchUiStore.getState().pendingDialog).toBeNull()
    expect(screen.queryByRole('menu')).toBeNull()
    // The line tool keeps being the line tool, with no half-drawn gesture left
    // pointing at the pre-undo document.
    expect(store.activeTool).toBe('line')
    expect(store.drawPoints).toEqual([])
    expect(store.modeStack).toEqual(['tool:line'])
  })
})
