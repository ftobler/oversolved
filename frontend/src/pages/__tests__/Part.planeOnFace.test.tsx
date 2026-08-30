/**
 * Regression tests for the nested edit session guard (feature/undo-nested-
 * session-guard.md).
 *
 * The plane-on-face effect (the "Sketch" toolbar button arms a plane pick,
 * then the effect enters edit mode as soon as the pick chip should show) used
 * to call enterEditFeature straight into whatever session was already open,
 * tripping startEditSession's nested guard and, in production, silently
 * clobbering the outer session's undo snapshot. It also entered the sketch as
 * a suppressed (one-aggregate) session instead of the per-action session
 * every other sketch edit gets, and left editingFeatureId stranded when a
 * plane pick was abandoned before landing.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'
import { Wrapper, partDocStoreMock } from '@/__tests__/test-utils'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { executeCommand } from '@/utils/core/commandRegistry'

vi.mock('../../components/Viewport', () => ({
  default: vi.fn(() => null),
  __esModule: true,
}))

const SKETCH_AND_EXTRUDE_DOC = `version: 1
kind: part
features:
  - id: sk0
    kind: sketch
    label: Sketch 0
  - id: ex1
    kind: extrude
    label: Extrude 1
    extrude: { sketch: '$sk0', distance: 10, direction: 'normal' }
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

describe('plane-on-face and the nested edit session guard', () => {
  it('closes an open feature session first, then opens the new sketch per-action', async () => {
    partDocStoreMock({ content: SKETCH_AND_EXTRUDE_DOC })
    renderPart()
    await screen.findByTitle('Feature mode')
    fireEvent.click(screen.getByTitle('Feature mode'))

    await waitFor(() => expect(screen.getByText('Extrude 1')).toBeInTheDocument())
    fireEvent.click(screen.getByTitle('Edit extrude'))
    await waitFor(() => expect(usePartEditorStore.getState().editingFeatureId).toBe('ex1'))

    // Plane-on-face fires here: adding a sketch while ex1's session is open.
    await act(async () => { fireEvent.click(screen.getByTitle('Sketch')) })

    const editingId = await waitFor(() => {
      const id = usePartEditorStore.getState().editingFeatureId
      expect(id).not.toBeNull()
      expect(id).not.toBe('ex1')
      return id!
    })

    // ex1's session closed cleanly: no nested-session refusal left it stuck,
    // and its own OK/Cancel are gone because it committed rather than hanging.
    const ex1Item = screen.getByText('Extrude 1').closest('.feature-item') as HTMLElement
    expect(within(ex1Item).queryByTitle('OK')).toBeNull()
    expect(within(ex1Item).queryByTitle('Cancel')).toBeNull()

    // The new session belongs to a sketch, entered via enterEditSketch.
    const newFeature = usePartEditorStore.getState().features.find(f => f.id === editingId)
    expect(newFeature?.kind).toBe('sketch')

    // Per-action, not suppressed: toggling a DIFFERENT feature's visibility
    // while this sketch session is open must each push their own undo entry
    // immediately, not swallow into the sketch's eventual aggregate. sk0
    // always carries a visibility button (sketches do regardless of which
    // feature is being edited), so it is the probe. Two toggles net back to
    // the starting state but, if per-action, leave two distinct entries.
    const sk0Item = () => screen.getByText('Sketch 0').closest('.feature-item') as HTMLElement
    fireEvent.click(within(sk0Item()).getByTitle('Hide'))
    await waitFor(() => expect(within(sk0Item()).queryByTitle('Show')).not.toBeNull())
    fireEvent.click(within(sk0Item()).getByTitle('Show'))
    await waitFor(() => expect(within(sk0Item()).queryByTitle('Hide')).not.toBeNull())

    // Undo always tears down whatever session is open (registerUndoTeardown),
    // so this cannot use editingFeatureId surviving as its signal. Instead:
    // one undo must pop only the SECOND toggle, landing sk0 back on hidden. A
    // suppressed (aggregate) session would have swallowed both toggles with
    // no entries of their own, so this undo would instead revert add_sketch
    // itself and delete the new sketch feature entirely.
    await act(async () => { executeCommand('undo') })

    await waitFor(() => {
      expect(within(sk0Item()).queryByTitle('Show')).not.toBeNull()
    })
    expect(usePartEditorStore.getState().features.some(f => f.id === editingId)).toBe(true)
  })

  it('abandoning a plane pick before it lands leaves no half-open session', async () => {
    partDocStoreMock({ content: SKETCH_AND_EXTRUDE_DOC })
    renderPart()
    await screen.findByTitle('Feature mode')
    fireEvent.click(screen.getByTitle('Feature mode'))

    await act(async () => { fireEvent.click(screen.getByTitle('Sketch')) })

    const newSketchId = await waitFor(() => {
      const id = usePartEditorStore.getState().editingFeatureId
      expect(id).not.toBeNull()
      return id!
    })

    // Abandon the pick: click the pick-chip itself, the same toggle-off a
    // user drives via Escape (cancel_draw) or re-clicking the chip.
    const chip = document.querySelector('.feature-pick-chip')
    expect(chip).not.toBeNull()
    await act(async () => { fireEvent.click(chip!) })

    await waitFor(() => {
      expect(usePartEditorStore.getState().editingFeatureId).toBeNull()
    })

    // The sketch itself is not deleted, only its edit session resolved -- the
    // feature tree still lists it with no plane assigned.
    const stillThere = usePartEditorStore.getState().features.find(f => f.id === newSketchId)
    expect(stillThere).toBeDefined()
    expect((stillThere as { plane?: string }).plane).toBeFalsy()
  })
})
