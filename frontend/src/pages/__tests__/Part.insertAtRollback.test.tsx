// Adding a feature while the rollback bar is parked mid-stack must insert the
// feature at the bar and keep the downstream stack behind it. The bar ends up
// just past the new row (the slot it already named, shifted by the insert),
// not at the end of the stack as the old append-and-unroll path did.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { BUILTIN_FEATURE_IDS } from '@/hooks/usePartDoc'
import { Wrapper, partDocStoreMock } from '@/__tests__/test-utils'
import { useEditorState } from '@/hooks/useEditorState'
import { solveViaWorker } from '@/kernel/worker/solverClient'

vi.mock('@/kernel/worker/solverClient', () => ({
  solveViaWorker: vi.fn().mockResolvedValue({ result: {}, bodies: {}, pick_bodies: {}, _build_state: null }),
}))

vi.mock('../../components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule({ cancelPendingFit: vi.fn() }))

// Built-ins occupy 0..3, so the bar at 5 sits between sk1 (4) and ex1 (5).
// Everything from ex1 onward is rolled back before the add.
const PARKED_DOC = `version: 1
kind: part
rollback: 5
features:
  - id: Origin
    kind: origin
  - id: Top
    kind: plane
  - id: Front
    kind: plane
  - id: Right
    kind: plane
  - id: sk1
    kind: sketch
    label: sketch 1
  - id: ex1
    kind: extrude
    label: extrude 1
    extrude: { sketch: '$sk1', distance: 10, direction: 'normal' }
  - id: f2
    kind: fillet
    label: fillet 1
  - id: f3
    kind: chamfer
    label: chamfer 1
`

const features = () => usePartEditorStore.getState().features
const userFeatures = () => features().filter(f => !BUILTIN_FEATURE_IDS.has(f.id))
const docRollback = () => usePartEditorStore.getState().doc?.rollback

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

describe('Part - adding a feature while rolled back', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    useEditorState.setState({
      editingFeatureId: null,
      pickBoundary: null,
      rollbackPosition: null,
    })
    partDocStoreMock()
  })

  it('inserts at the bar and parks it just past the new feature, not at the end', async () => {
    partDocStoreMock({ content: PARKED_DOC })
    renderPart()
    await waitFor(() => expect(userFeatures().map(f => f.kind))
      .toEqual(['sketch', 'extrude', 'fillet', 'chamfer']))
    await waitFor(() => expect(useEditorState.getState().rollbackPosition).toBe(5))

    fireEvent.click(screen.getByTitle('Feature mode'))
    await act(async () => { fireEvent.click(screen.getByTitle('Add Extrude (E)')) })
    await waitFor(() => expect(userFeatures()).toHaveLength(5))

    // The new extrude takes index 5 (the bar's slot); the old downstream stack
    // shifts down behind it rather than the new feature landing past it.
    expect(features()[5].kind).toBe('extrude')
    expect(features()[5].id).not.toBe('ex1')
    expect(features().slice(6).map(f => f.id)).toEqual(['ex1', 'f2', 'f3'])

    // The bar is just past the new feature, not at the end of the longer stack.
    expect(useEditorState.getState().rollbackPosition).toBe(6)
    expect(docRollback()).toBe(6)

    // The add's solve covers the inserted row under the pick boundary of its
    // slot, and stops at the bar (the old downstream extrude is not built).
    const addedId = features()[5].id
    await waitFor(() => {
      const calls = vi.mocked(solveViaWorker).mock.calls
      const payload = calls[calls.length - 1]?.[0] as { features?: { id: string }[] } | undefined
      expect(payload?.features?.some(f => f.id === addedId)).toBe(true)
    })
    const calls = vi.mocked(solveViaWorker).mock.calls
    const payload = calls[calls.length - 1][0] as {
      features: { id: string }[]
      rollback_position: number
      pick_boundary?: number
    }
    expect(payload.features.map(f => f.id)).toEqual(['sk1', addedId])
    expect(payload.rollback_position).toBe(2)
    expect(payload.pick_boundary).toBe(1)

    // OK keeps the parked slot; the downstream stack stays rolled back. The
    // floating panel also carries an OK pair, so target the editing row's.
    await act(async () => { fireEvent.click(document.querySelector('.feature-item.editing .feature-ok-btn')!) })
    await waitFor(() => expect(useEditorState.getState().editingFeatureId).toBeNull())
    expect(useEditorState.getState().rollbackPosition).toBe(6)
    expect(docRollback()).toBe(6)
    expect(features()[6].id).toBe('ex1')
  })

  it('Cancel removes the inserted feature and restores the parked position', async () => {
    partDocStoreMock({ content: PARKED_DOC })
    renderPart()
    await waitFor(() => expect(userFeatures()).toHaveLength(4))
    await waitFor(() => expect(useEditorState.getState().rollbackPosition).toBe(5))

    fireEvent.click(screen.getByTitle('Feature mode'))
    await act(async () => { fireEvent.click(screen.getByTitle('Add Extrude (E)')) })
    await waitFor(() => expect(userFeatures()).toHaveLength(5))
    await waitFor(() => expect(document.querySelector('.feature-item.editing .feature-cancel-btn')!).toBeInTheDocument())

    await act(async () => { fireEvent.click(document.querySelector('.feature-item.editing .feature-cancel-btn')!) })
    await waitFor(() => expect(userFeatures()).toHaveLength(4))
    expect(userFeatures().map(f => f.id)).toEqual(['sk1', 'ex1', 'f2', 'f3'])
    expect(useEditorState.getState().rollbackPosition).toBe(5)
    expect(docRollback()).toBe(5)
  })
})
