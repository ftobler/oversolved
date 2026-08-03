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

vi.mock('@/kernel/solveLocally', () => ({
  solveLocally: vi.fn().mockResolvedValue({ result: {}, bodies: {}, pick_bodies: {}, _build_state: null }),
}))

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
})
