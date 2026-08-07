/**
 * Regression test: entering and exiting edit mode on a non-last feature must
 * restore the rollback position to the full stack so that features after it
 * are re-solved on exit.
 *
 * Bug: exitEditFeature compared rollbackPosition against savedRollbackPosition
 * (the pre-edit full-stack position), but enterEditFeature had already set
 * rollbackPosition to idx+1. For any feature except the last, idx+1 !=
 * savedRollbackPosition so the condition was always false and the rollback
 * was never restored -- features after the edited one disappeared.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { Wrapper, partDocFetchMock } from '@/__tests__/test-utils'

vi.mock('../../components/Viewport', () => ({
  default: vi.fn(() => null),
  __esModule: true,
}))

const TWO_FILLETS_DOC = `version: 1
kind: part
features:
  - id: sk1
    kind: sketch
    label: Sketch 1
  - id: ex1
    kind: extrude
    label: Extrude 1
    extrude: { sketch: '$sk1', distance: 10, direction: 'normal' }
  - id: fil1
    kind: fillet
    label: Fillet 1
    edges: []
    radius: 1
  - id: fil2
    kind: fillet
    label: Fillet 2
    edges: []
    radius: 2
`

// No sketch before the extrude: Extrude 1 is the first non-builtin, non-sketch
// feature, so computePickBoundary returns 0 for it (the empty doc).
const FIRST_EXTRUDE_DOC = `version: 1
kind: part
features:
  - id: ex1
    kind: extrude
    label: Extrude 1
    extrude: { sketch: '$sk1', distance: 10, direction: 'normal' }
  - id: fil1
    kind: fillet
    label: Fillet 1
    edges: []
    radius: 1
`

describe('feature edit rollback restore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('enters edit mode on the first non-builtin non-sketch feature with pickBoundary 0', async () => {
    vi.stubGlobal('fetch', partDocFetchMock({ content: FIRST_EXTRUDE_DOC }))

    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>,
      { wrapper: Wrapper }
    )

    await waitFor(() => {
      expect(screen.getByText('Extrude 1')).toBeInTheDocument()
    })

    // Enter edit mode on Extrude 1: with no sketch before it, the pick boundary
    // is 0, the empty doc before the first feature. The edit must still engage
    // (the store pins the boundary and the feature tree rolls Fillet 1 back).
    const editBtn = screen.getByTitle('Edit extrude')
    fireEvent.click(editBtn)

    await waitFor(() => {
      expect(usePartEditorStore.getState().editingFeatureId).toBe('ex1')
      expect(usePartEditorStore.getState().pickBoundary).toBe(0)
      expect(usePartEditorStore.getState().rollbackPosition).toBe(1)
    })

    // Fillet 1 is now rolled back (grayed out)
    await waitFor(() => {
      const fil1 = screen.getByText('Fillet 1').closest('.feature-item')
      expect(fil1?.classList.contains('rolled-back')).toBe(true)
    })

    // Exit edit mode
    fireEvent.click(screen.getByTitle('OK'))

    await waitFor(() => {
      const fil1 = screen.getByText('Fillet 1').closest('.feature-item')
      expect(fil1?.classList.contains('rolled-back')).toBe(false)
    })
  })

  it('rollback bar returns to end after exiting edit mode on non-last feature', async () => {
    vi.stubGlobal('fetch', partDocFetchMock({ content: TWO_FILLETS_DOC }))

    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>,
      { wrapper: Wrapper }
    )

    await waitFor(() => {
      expect(screen.getByText('Fillet 1')).toBeInTheDocument()
      expect(screen.getByText('Fillet 2')).toBeInTheDocument()
    })

    // Rollback bar starts at the end (after Fillet 2, no feature is rolled back)
    await waitFor(() => {
      expect(screen.queryByTitle('Rollback')).toBeInTheDocument()
    })
    const filletItems = screen.getAllByTitle('Rollback')
    expect(filletItems.length).toBeGreaterThan(0)

    // Enter edit mode on Fillet 1 (not the last feature)
    const editBtns = screen.getAllByTitle('Edit fillet')
    fireEvent.click(editBtns[0])

    // Fillet 2 should now be rolled back (grayed out)
    await waitFor(() => {
      const fil2 = screen.getByText('Fillet 2').closest('.feature-item')
      expect(fil2?.classList.contains('rolled-back')).toBe(true)
    })

    // Exit edit mode on Fillet 1
    fireEvent.click(screen.getByTitle('OK'))

    // Fillet 2 must no longer be rolled back -- rollback is restored to full stack
    await waitFor(() => {
      const fil2 = screen.getByText('Fillet 2').closest('.feature-item')
      expect(fil2?.classList.contains('rolled-back')).toBe(false)
    })
  })

  it('editing the last feature and exiting also restores correctly', async () => {
    vi.stubGlobal('fetch', partDocFetchMock({ content: TWO_FILLETS_DOC }))

    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>,
      { wrapper: Wrapper }
    )

    await waitFor(() => {
      expect(screen.getByText('Fillet 2')).toBeInTheDocument()
    })

    // Enter edit mode on Fillet 2 (the last feature)
    const editBtns = screen.getAllByTitle('Edit fillet')
    fireEvent.click(editBtns[editBtns.length - 1])

    // Fillet 2 itself is now in edit mode -- nothing after it to roll back
    await waitFor(() => {
      const fil2 = screen.getByText('Fillet 2').closest('.feature-item')
      expect(fil2?.classList.contains('editing')).toBe(true)
    })

    // Exit
    fireEvent.click(screen.getByTitle('OK'))

    // Everything still visible and not rolled back
    await waitFor(() => {
      const fil1 = screen.getByText('Fillet 1').closest('.feature-item')
      const fil2 = screen.getByText('Fillet 2').closest('.feature-item')
      expect(fil1?.classList.contains('rolled-back')).toBe(false)
      expect(fil2?.classList.contains('rolled-back')).toBe(false)
    })
  })
})
