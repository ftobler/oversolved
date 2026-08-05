import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'
import { executeCommand } from '@/utils/core/commandRegistry'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { Wrapper, partDocFetchMock } from '@/__tests__/test-utils'

// Undo swaps in a document the open editor session knows nothing about. These
// tests walk the page the way a user does, because the teardown is composed
// from three owners (usePartDoc's session refs, useEditFeature's UI reset and
// Part's own popovers) and only the assembled page proves they all fire.

// `cancelPendingFit` is deliberately not in the mock's default handle set, and
// undo drives it, so this suite has to ask for it explicitly.
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

describe('Part - undo tears down transient editor state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSketchEditorStore.setState({
      normalSelection: new Set(),
      selectedPicks: new Map(),
      chipOwnedSelection: new Set(),
      activePickField: null,
      modeStack: [],
      pendingDialog: null,
    })
  })

  it('clears selection, the pick field and the edit while undoing an added feature', async () => {
    vi.stubGlobal('fetch', partDocFetchMock())
    renderPart()
    await screen.findByTitle('Feature mode')

    fireEvent.click(screen.getByTitle('Feature mode'))
    await act(async () => { fireEvent.click(screen.getByTitle('Add Extrude (E)')) })

    // Adding a feature enters it and arms its first pick field, so the page is
    // now in exactly the half-open state undo has to unwind.
    await waitFor(() => {
      expect(usePartEditorStore.getState().editingFeatureId).not.toBeNull()
      expect(useSketchEditorStore.getState().activePickField).not.toBeNull()
    })
    act(() => {
      useSketchEditorStore.setState({ normalSelection: new Set(['?01;deadbeef:face']) })
      useSketchEditorStore.getState().openDialog({ position: [0, 0], label: 'Length', onConfirm: () => {} })
    })

    await act(async () => { executeCommand('undo') })

    const sketchStore = useSketchEditorStore.getState()
    expect(usePartEditorStore.getState().editingFeatureId).toBeNull()
    expect(sketchStore.activePickField).toBeNull()
    expect(sketchStore.modeStack).not.toContain('pick')
    expect(sketchStore.normalSelection.size).toBe(0)
    expect(sketchStore.pendingDialog).toBeNull()
  })

  it('leaves sketch mode when the undo closes the sketch edit behind it', async () => {
    vi.stubGlobal('fetch', partDocFetchMock({ content: SKETCH_DOC }))
    renderPart()
    await screen.findByTitle('Feature mode')

    // Put one real entry on the stack first, so the undo below has something to
    // pop and actually reaches the teardown.
    fireEvent.click(screen.getByTitle('Feature mode'))
    await act(async () => { fireEvent.click(screen.getByTitle('Add Extrude (E)')) })
    await act(async () => { fireEvent.click(screen.getByTitle('OK')) })

    await act(async () => { fireEvent.click(screen.getByTitle('Edit sketch')) })
    await waitFor(() => {
      expect(screen.getByTitle('Sketch mode').className).toContain('active')
    })

    await act(async () => { executeCommand('undo') })

    // The sketch toolbar has no sketch left to act on, so the panel falls back
    // to the feature tab.
    expect(screen.getByTitle('Feature mode').className).toContain('active')
    expect(usePartEditorStore.getState().editingFeatureId).toBeNull()
  })

  // Deliberate, not incidental: the selection is dropped even when the undone
  // step could not possibly have invalidated it. See the call site in Part.tsx
  // for why this is not decided per entry.
  it('clears the selection on an undo made with no edit session open', async () => {
    vi.stubGlobal('fetch', partDocFetchMock({ content: SKETCH_DOC }))
    renderPart()
    await screen.findByTitle('Feature mode')

    fireEvent.click(screen.getByTitle('Feature mode'))
    await act(async () => { fireEvent.click(screen.getByTitle('Add Extrude (E)')) })
    await act(async () => { fireEvent.click(screen.getByTitle('OK')) })
    expect(usePartEditorStore.getState().editingFeatureId).toBeNull()

    act(() => {
      useSketchEditorStore.setState({ normalSelection: new Set(['?01;deadbeef:face', '?01;cafef00d:face']) })
    })

    await act(async () => { executeCommand('undo') })

    expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
  })

  it('an undo with an empty stack tears nothing down', async () => {
    vi.stubGlobal('fetch', partDocFetchMock())
    renderPart()
    await screen.findByTitle('Feature mode')

    act(() => {
      useSketchEditorStore.setState({ normalSelection: new Set(['?01;deadbeef:face']) })
    })

    // A keystroke that changes nothing must not clear the user's selection as a
    // side effect, so the teardown sits behind the empty-stack guard.
    await act(async () => { executeCommand('undo') })

    expect(useSketchEditorStore.getState().normalSelection.size).toBe(1)
  })
})
