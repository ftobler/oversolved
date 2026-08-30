/**
 * Entering a feature edit turns on the ghost preview (solid "before" bodies plus
 * a pink overlay of what the edit adds). Both halves come from the solve that
 * carries the pick bodies, so ghost mode must wait for it: while that solve is
 * in flight there is no "before" state, the overlay has nothing to subtract, and
 * the whole model flashes as pink wireframe.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'
import { Wrapper, partDocStoreMock } from '@/__tests__/test-utils'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { solveViaWorker } from '@/kernel/worker/solverClient'

vi.mock('@/kernel/worker/solverClient', () => ({
  solveViaWorker: vi.fn(),
  cancelSolver: vi.fn(),
}))

vi.mock('../../components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule())

const DOC = `version: 1
kind: part
features:
  - id: sk1
    kind: sketch
    label: Sketch 1
  - id: ex1
    kind: extrude
    label: Extrude 1
    extrude: { sketch: '$sk1', distance: 10, direction: 'normal' }
  - id: db1
    kind: delete_body
    label: Delete Body 1
    delete_body: { bodies: [] }
`

const BODIES = { body_ex1: { id: 'body_ex1', created_by: 'ex1', modified_by: [], mesh: { vertices: [], faces: [] } } }

describe('delete_body ghost preview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    usePartEditorStore.setState({ editingFeatureId: null, pickBoundary: null, rollbackPosition: null, ghostMode: false })
  })

  it('turns ghost mode on only once the pick bodies land', async () => {
    // The edit solve (the one asking for a pick boundary) is held open so the
    // in-flight window is observable.
    let releaseEditSolve!: (v: unknown) => void
    const editSolve = new Promise(r => { releaseEditSolve = r })
    const mock = solveViaWorker as ReturnType<typeof vi.fn>
    mock.mockImplementation((_payload: unknown, opts?: { pickBoundary?: number | null }) =>
      opts?.pickBoundary != null
        ? editSolve
        : Promise.resolve({ result: {}, bodies: BODIES, _build_state: null }),
    )
    partDocStoreMock({ content: DOC })

    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>,
      { wrapper: Wrapper }
    )

    const editBtn = await screen.findByTitle('Edit delete body')
    fireEvent.click(editBtn)

    await waitFor(() => expect(usePartEditorStore.getState().pickBoundary).not.toBeNull())
    expect(usePartEditorStore.getState().ghostMode).toBe(false)

    releaseEditSolve({ result: {}, bodies: {}, pick_bodies: BODIES, _build_state: null })
    await waitFor(() => expect(usePartEditorStore.getState().ghostMode).toBe(true))
    expect(usePartEditorStore.getState().pickBodies).toEqual(BODIES)
    // The delete emptied the body store, so the ghosts are all that is left.
    expect(usePartEditorStore.getState().bodies).toEqual({})
  })
})
