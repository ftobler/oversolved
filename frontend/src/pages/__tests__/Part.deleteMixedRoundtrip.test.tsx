/**
 * Round-trip proof for the Delete-key mixed selection rule: when the selection
 * holds a body AND the feature that generates it, only the feature is deleted.
 * A delete_body aimed at the vanished body would fail solveDeleteBody on every
 * later solve (`body not found`), so the doc handed to the kernel after Delete
 * must carry no delete_body feature at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'
import { executeCommand } from '@/utils/core/commandRegistry'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { Wrapper, partDocStoreMock } from '@/__tests__/test-utils'

const mockSolveViaWorker = vi.hoisted(() => vi.fn())

vi.mock('@/kernel/worker/solverClient', () => ({
  solveViaWorker: mockSolveViaWorker,
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
`

const BODIES = { body_ex1: { id: 'body_ex1', created_by: 'ex1', modified_by: [] } }

function resetSelection() {
  useSketchEditorStore.setState({
    normalSelection: new Set(),
    selectedPicks: new Map(),
    chipOwnedSelection: new Set(),
    selectionDomain: 'sketch_2d',
    activeFeatureId: null,
    activeTool: null,
    activePickField: null,
    modeStack: [],
  })
}

describe('Delete on a body plus its generator feature', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSelection()
    mockSolveViaWorker.mockResolvedValue({ result: {}, bodies: BODIES, pick_bodies: {}, _build_state: null })
  })

  it('hands the kernel a doc with the feature gone and no delete_body feature', async () => {
    partDocStoreMock({ content: DOC })
    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:uuid" element={<Part />} />
        </Routes>
      </MemoryRouter>,
      { wrapper: Wrapper }
    )

    await waitFor(() => expect(usePartEditorStore.getState().bodies?.body_ex1).toBeTruthy())
    fireEvent.click(screen.getByTitle('Feature mode'))

    act(() => { useSketchEditorStore.getState().addToNormalSelection('@ex1') })
    act(() => { useSketchEditorStore.getState().addToNormalSelection('@body_ex1') })
    await act(async () => { executeCommand('delete_selected') })

    // The re-solve the Delete triggered is the last one; its feature list is
    // the final doc. ex1 is gone and NO delete_body was left behind to throw a
    // `body not found` on the next solve.
    const payloads = mockSolveViaWorker.mock.calls.map(c => c[0])
    const features = payloads[payloads.length - 1].features as { id: string; kind: string }[]
    expect(features.some(f => f.id === 'ex1')).toBe(false)
    expect(features.some(f => f.kind === 'delete_body')).toBe(false)
    expect(features.some(f => f.id === 'sk1')).toBe(true)
  })
})
