/**
 * Regression test for the general (non-plane-on-face) nested-session path:
 * the FeatureTree Edit button stays clickable on every OTHER feature's row
 * while one feature is being edited (`showEditBtn = !isEditing` is per-row,
 * `FeatureItemActions.tsx`), wired straight to `enterEditFeature`
 * (`Part.tsx` -> `useEditFeature.ts`). Before the one-open-editor guard moved
 * into `enterEditFeature` itself, clicking Edit on feature C while feature D
 * was open either clobbered D's undo snapshot (prod, pre-failLoud-return fix)
 * or silently no-opped (after the failLoud-return fix alone, since the guard
 * only closed D for the plane-on-face caller). Neither is acceptable: this
 * pins that ANY caller closes the open editor first and opens the new one
 * cleanly.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'
import { Wrapper, partDocFetchMock } from '@/__tests__/test-utils'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { executeCommand } from '@/utils/core/commandRegistry'

vi.mock('../../components/Viewport', () => ({
  default: vi.fn(() => null),
  __esModule: true,
}))

const TWO_FILLETS_DOC = `version: 1
kind: part
features:
  - id: fil1
    kind: fillet
    label: Fillet 1
    fillet: { edges: [], radius: 1 }
  - id: fil2
    kind: fillet
    label: Fillet 2
    fillet: { edges: [], radius: 2 }
`

const FILLET_AND_SKETCH_DOC = `version: 1
kind: part
features:
  - id: fil1
    kind: fillet
    label: Fillet 1
    fillet: { edges: [], radius: 1 }
  - id: sk1
    kind: sketch
    label: Sketch 1
`

const SKETCH_AND_FILLET_DOC = `version: 1
kind: part
features:
  - id: sk1
    kind: sketch
    label: Sketch 1
  - id: fil1
    kind: fillet
    label: Fillet 1
    fillet: { edges: [], radius: 1 }
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

function radiusOf(id: string): number | undefined {
  const feature = usePartEditorStore.getState().features.find(f => f.id === id) as { fillet?: { radius?: number } } | undefined
  return feature?.fillet?.radius
}

describe('nested edit session guard (direct FeatureTree Edit button)', () => {
  it('clicking Edit on feature C while feature D is open closes D into its own entry and opens C clean', async () => {
    vi.stubGlobal('fetch', partDocFetchMock({ content: TWO_FILLETS_DOC }))
    renderPart()
    await screen.findByTitle('Feature mode')
    fireEvent.click(screen.getByTitle('Feature mode'))

    await waitFor(() => expect(screen.getByText('Fillet 1')).toBeInTheDocument())

    // Open D (Fillet 1) and make an in-session edit that would otherwise be
    // swallowed by its suppressed aggregate session.
    fireEvent.click(screen.getAllByTitle('Edit fillet')[0])
    await waitFor(() => expect(usePartEditorStore.getState().editingFeatureId).toBe('fil1'))

    const radiusInput = screen.getByLabelText('Radius') as HTMLInputElement
    fireEvent.change(radiusInput, { target: { value: '5' } })
    fireEvent.blur(radiusInput)
    await waitFor(() => expect(radiusOf('fil1')).toBe(5))

    // D's own Edit button is hidden while it is open, so the one Edit button
    // left is C's (Fillet 2). This is the direct-click path, not plane-on-face:
    // no pick field, no effect, just the button wired straight to
    // enterEditFeature.
    fireEvent.click(screen.getByTitle('Edit fillet'))

    // C opens: D closed cleanly instead of silently no-opping or clobbering.
    await waitFor(() => expect(usePartEditorStore.getState().editingFeatureId).toBe('fil2'))
    const fil1Item = screen.getByText('Fillet 1').closest('.feature-item') as HTMLElement
    expect(within(fil1Item).queryByTitle('OK')).toBeNull()
    expect(within(fil1Item).queryByTitle('Cancel')).toBeNull()
    // D's edit was not lost: it committed into the doc (and, below, into its
    // own undo entry) rather than being dropped by a silent refusal.
    expect(radiusOf('fil1')).toBe(5)

    // Undo walks back correctly: D's aggregate is its own entry, so one undo
    // (which also tears down C's now-open session, same as any undo) reverts
    // exactly D's radius change.
    await act(async () => { executeCommand('undo') })
    await waitFor(() => expect(radiusOf('fil1')).toBe(1))
  })

  // Same guard, a different door in: "Edit sketch" routes through
  // enterEditSketch (per-action undo), not enterEditFeature directly, and the
  // target kind differs from the open one (fillet -> sketch). Confirms the
  // close-then-open generalizes across both the entry point and the kind,
  // not just the fillet-editing-fillet case above.
  it('clicking Edit sketch while a different feature is open closes it first too', async () => {
    vi.stubGlobal('fetch', partDocFetchMock({ content: FILLET_AND_SKETCH_DOC }))
    renderPart()
    await screen.findByTitle('Feature mode')
    fireEvent.click(screen.getByTitle('Feature mode'))

    await waitFor(() => expect(screen.getByText('Fillet 1')).toBeInTheDocument())

    fireEvent.click(screen.getByTitle('Edit fillet'))
    await waitFor(() => expect(usePartEditorStore.getState().editingFeatureId).toBe('fil1'))

    const radiusInput = screen.getByLabelText('Radius') as HTMLInputElement
    fireEvent.change(radiusInput, { target: { value: '9' } })
    fireEvent.blur(radiusInput)
    await waitFor(() => expect(radiusOf('fil1')).toBe(9))

    fireEvent.click(screen.getByTitle('Edit sketch'))

    await waitFor(() => expect(usePartEditorStore.getState().editingFeatureId).toBe('sk1'))
    const fil1Item = screen.getByText('Fillet 1').closest('.feature-item') as HTMLElement
    expect(within(fil1Item).queryByTitle('OK')).toBeNull()
    expect(radiusOf('fil1')).toBe(9)

    await act(async () => { executeCommand('undo') })
    await waitFor(() => expect(radiusOf('fil1')).toBe(1))
  })

  // The reverse direction: the OPEN session is a sketch (per-action, not
  // suppressed), so commitEditSession has no aggregate to push -- closing it
  // must still reset the UI state cleanly and must not manufacture a spurious
  // undo entry. Confirmed by there being exactly one real entry afterward
  // (the fillet edit), not two.
  it('opening a fillet while an untouched sketch session is open closes it with no phantom entry', async () => {
    vi.stubGlobal('fetch', partDocFetchMock({ content: SKETCH_AND_FILLET_DOC }))
    renderPart()
    await screen.findByTitle('Feature mode')
    fireEvent.click(screen.getByTitle('Feature mode'))

    await waitFor(() => expect(screen.getByText('Sketch 1')).toBeInTheDocument())

    fireEvent.click(screen.getByTitle('Edit sketch'))
    await waitFor(() => expect(usePartEditorStore.getState().editingFeatureId).toBe('sk1'))

    fireEvent.click(screen.getByTitle('Edit fillet'))

    await waitFor(() => expect(usePartEditorStore.getState().editingFeatureId).toBe('fil1'))
    const sk1Item = screen.getByText('Sketch 1').closest('.feature-item') as HTMLElement
    expect(within(sk1Item).queryByTitle('OK')).toBeNull()

    const radiusInput = screen.getByLabelText('Radius') as HTMLInputElement
    fireEvent.change(radiusInput, { target: { value: '7' } })
    fireEvent.blur(radiusInput)
    await waitFor(() => expect(radiusOf('fil1')).toBe(7))

    // Commit fil1's own (suppressed) session so its aggregate lands as a real
    // entry, then undo. One undo must land all the way back on the untouched
    // radius: the sketch's empty session left no phantom entry of its own
    // behind for this undo to pop through first.
    fireEvent.click(screen.getByTitle('OK'))
    await act(async () => { executeCommand('undo') })
    await waitFor(() => expect(radiusOf('fil1')).toBe(1))
  })
})
