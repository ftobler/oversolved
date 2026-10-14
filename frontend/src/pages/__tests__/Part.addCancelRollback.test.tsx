// Cancel on a just-added feature rewinds the doc to the session snapshot, which
// was taken before the add moved the rollback bar to the end of the longer
// stack. The bar is document content, but the re-solve that follows reads its
// position off the STORE (useSolver), so a cancel that left the store where the
// add parked it would rebuild the whole stack while the document says most of it
// is rolled back - and the next reload would then read the parked value out of
// the document and the features past it would vanish.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { stringify as stringifyYaml } from 'yaml'
import Part from '@/pages/Part'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { BUILTIN_FEATURE_IDS } from '@/hooks/usePartDoc'
import { Wrapper, partDocStoreMock } from '@/__tests__/test-utils'

vi.mock('@/kernel/worker/solverClient', () => ({
  solveViaWorker: vi.fn().mockResolvedValue({ result: {}, bodies: {}, pick_bodies: {}, _build_state: null }),
}))

vi.mock('../../components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule({ cancelPendingFit: vi.fn() }))

// Four user features on top of the built-ins (so the stack is 8 long), with the
// bar parked at 2: slots 2..8 are rolled back and only the first two build.
const PARKED_DOC = `version: 1
kind: part
rollback: 2
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
  - id: f2
    kind: fillet
    label: fillet 1
  - id: f3
    kind: chamfer
    label: chamfer 1
`

const userFeatures = () =>
  usePartEditorStore.getState().features.filter(f => !BUILTIN_FEATURE_IDS.has(f.id))

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

describe('Part - cancelling an added feature keeps the rollback bar and the document in step', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    usePartEditorStore.setState({ editingFeatureId: null, pickBoundary: null, rollbackPosition: null })
    partDocStoreMock()
  })

  it('Cancel rewinds the bar to the parked position and a reload agrees', async () => {
    partDocStoreMock({ content: PARKED_DOC })
    const view = renderPart()
    await waitFor(() => expect(userFeatures().map(f => f.kind))
      .toEqual(['sketch', 'extrude', 'fillet', 'chamfer']))
    await waitFor(() => expect(usePartEditorStore.getState().rollbackPosition).toBe(2))
    expect(usePartEditorStore.getState().doc?.rollback).toBe(2)

    fireEvent.click(screen.getByTitle('Feature mode'))
    await act(async () => { fireEvent.click(screen.getByTitle('Add Extrude (E)')) })
    await waitFor(() => expect(userFeatures()).toHaveLength(5))
    await waitFor(() => expect(screen.getByTitle('Cancel')).toBeInTheDocument())

    await act(async () => { fireEvent.click(screen.getByTitle('Cancel')) })
    await waitFor(() => expect(userFeatures()).toHaveLength(4))

    // The store and the document name the same position after the rewind, so the
    // re-solve rebuilds exactly the stack the document describes.
    expect(docRollback()).toBe(2)
    expect(usePartEditorStore.getState().rollbackPosition).toBe(2)

    // Reload from the bytes the document now holds: the parked position is what
    // the bar comes back to, so the two cannot drift apart across a save.
    const saved = usePartEditorStore.getState().doc!
    view.unmount()
    partDocStoreMock({ content: stringifyYaml(saved) })
    renderPart()
    await waitFor(() => expect(userFeatures()).toHaveLength(4))
    await waitFor(() => expect(usePartEditorStore.getState().rollbackPosition).toBe(2))
    expect(docRollback()).toBe(2)
  })
})
