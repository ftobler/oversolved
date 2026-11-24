// The open feature card carries Rename beside its OK/Cancel pair. The card only
// exists inside an edit session, so this suite drives the real usePartDoc and
// undo stack: a rename started there must behave like every other session edit,
// which the component suites (with mocked callbacks) cannot show.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'
import { executeCommand } from '@/hooks/commandRegistry'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useEditorState } from '@/hooks/useEditorState'
import { Wrapper, partDocStoreMock } from '@/__tests__/test-utils'

vi.mock('../../components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule({ cancelPendingFit: vi.fn() }))

const EXTRUDE_DOC = `version: 1
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

const SKETCH_DOC = `version: 1
kind: part
features:
  - id: sk1
    kind: sketch
    label: Sketch 1
    plane: '@builtin_plane_top'
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

function cardButton(className: string): HTMLElement {
  return document.querySelector(`.feature-edit-panel ${className}`) as HTMLElement
}

function dialogBox(): HTMLElement {
  return document.querySelector('.dialog-component') as HTMLElement
}

// The dialog's footer button shares the name 'Rename' with the card's icon
// button, so every click below is scoped to the dialog.
function renameFromCard(name: string) {
  fireEvent.click(cardButton('.feature-rename-btn'))
  const box = dialogBox()
  fireEvent.change(within(box).getByLabelText('Name'), { target: { value: name } })
  fireEvent.click(within(box).getByRole('button', { name: 'Rename' }))
}

async function openExtrudeEditor({ seedEntry = false } = {}) {
  await waitFor(() => expect(screen.getByText("extrude 'Extrude 1'", { selector: '.feature-name' })).toBeInTheDocument())
  fireEvent.click(screen.getByTitle('Feature mode'))
  // A mutation made inside the edit session is suppressed from the stack, so a
  // test that needs "the stack as it was on entry" seeds its entry first.
  if (seedEntry) await act(async () => { executeCommand('toggle_sketch_plane_visibility') })
  fireEvent.click(screen.getByTitle('Edit extrude'))
  await waitFor(() => expect(document.querySelector('.feature-edit-panel')).not.toBeNull())
}

describe('Part - rename from the open feature card', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useEditorState.setState({
      normalSelection: new Set(),
      selectedPicks: new Map(),
      activePickField: null,
      modeStack: [],
      editingFeatureId: null,
    })
  })

  it('shows the new name in the card title and the tree row while still open', async () => {
    partDocStoreMock({ content: EXTRUDE_DOC })
    renderPart()
    await openExtrudeEditor()

    renameFromCard('Boss')

    await waitFor(() => {
      expect(document.querySelector('.card-header-title')!.textContent).toBe("extrude 'Boss'")
    })
    expect(screen.getByText("extrude 'Boss'", { selector: '.feature-name' })).toBeInTheDocument()
  })

  it('Cancel reverts the rename and leaves the undo stack as it was on entry', async () => {
    partDocStoreMock({ content: EXTRUDE_DOC })
    renderPart()
    await openExtrudeEditor({ seedEntry: true })

    // One real entry under the session, so "unchanged" is not just an empty stack.
    const before = usePartEditorStore.getState().undoStack.length
    expect(before).toBeGreaterThan(0)

    renameFromCard('Boss')
    await waitFor(() => expect(document.querySelector('.card-header-title')!.textContent).toBe("extrude 'Boss'"))

    fireEvent.click(cardButton('.feature-cancel-btn'))

    await waitFor(() => {
      expect(screen.getByText("extrude 'Extrude 1'", { selector: '.feature-name' })).toBeInTheDocument()
    })
    expect(usePartEditorStore.getState().undoStack.length).toBe(before)
    expect(usePartEditorStore.getState().redoStack.length).toBe(0)
  })

  // A sketch edit is a real edit session (enterEditSketch opens one with undo
  // enabled), so a rename from its card is one mutation in that session: Cancel
  // reverts it just as it does for every other kind's card.
  it('reverts a sketch rename from its card when the sketch edit is cancelled', async () => {
    partDocStoreMock({ content: SKETCH_DOC })
    renderPart()
    await waitFor(() => expect(screen.getByTitle('Feature mode')).toBeInTheDocument())
    fireEvent.click(screen.getByTitle('Feature mode'))
    fireEvent.click(screen.getByTitle('Edit sketch'))
    await waitFor(() => expect(document.querySelector('.feature-edit-panel')).not.toBeNull())

    renameFromCard('Profile 1')
    await waitFor(() => {
      expect(usePartEditorStore.getState().features.find(f => f.id === 'sk1')!.label).toBe('Profile 1')
    })

    fireEvent.click(cardButton('.feature-cancel-btn'))
    await waitFor(() => {
      expect(usePartEditorStore.getState().features.find(f => f.id === 'sk1')!.label).toBe('Sketch 1')
    })
  })

  it('OK commits the rename and a same-session parameter change as one undo step', async () => {
    partDocStoreMock({ content: EXTRUDE_DOC })
    renderPart()
    await openExtrudeEditor({ seedEntry: true })

    const before = usePartEditorStore.getState().undoStack.length

    fireEvent.change(screen.getByLabelText('Distance, millimetres'), { target: { value: '20' } })
    renameFromCard('Boss')
    await waitFor(() => expect(document.querySelector('.card-header-title')!.textContent).toBe("extrude 'Boss'"))

    fireEvent.click(cardButton('.feature-ok-btn'))
    await waitFor(() => expect(document.querySelector('.feature-edit-panel')).toBeNull())

    expect(screen.getByText("extrude 'Boss'", { selector: '.feature-name' })).toBeInTheDocument()
    expect(usePartEditorStore.getState().undoStack.length).toBe(before + 1)

    await act(async () => { executeCommand('undo') })
    await waitFor(() => {
      expect(screen.getByText("extrude 'Extrude 1'", { selector: '.feature-name' })).toBeInTheDocument()
    })
    const ex1 = usePartEditorStore.getState().features.find(f => f.id === 'ex1')!
    expect(ex1).toMatchObject({ kind: 'extrude', extrude: { distance: 10 } })
  })
})
