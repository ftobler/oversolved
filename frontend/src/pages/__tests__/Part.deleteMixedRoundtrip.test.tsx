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
  (await import('@/__tests__/test-utils')).viewportMockModule({ cancelPendingFit: vi.fn() }))

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

  it('deletes the sketch entity AND the feature in ONE undo entry', async () => {
    // A mixed selection pressed inside the sketch editor must delete both
    // halves in a single history step. The store's deleteSelected only consumes
    // the sketch half then wipes the selection, so before the fix the page
    // handler ran second against an empty selection and the feature survived.
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

    act(() => {
      useSketchEditorStore.setState({
        activeFeatureId: 'sk1',
        normalSelection: new Set(['entity:sk1:L1', '@ex1']),
      })
    })
    await act(async () => { executeCommand('delete_selected') })

    // One press, one entry: the sketch delete and the feature delete ride the
    // same commitMutationGroup, so a single undo reverts both.
    expect(usePartEditorStore.getState().undoStack).toHaveLength(1)
    expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)

    // The 3D half actually landed: ex1 is gone from the solved feature list.
    const payloads = mockSolveViaWorker.mock.calls.map(c => c[0])
    const features = payloads[payloads.length - 1].features as { id: string }[]
    expect(features.some(f => f.id === 'ex1')).toBe(false)

    // And one undo restores it, proving the entry really covers the feature.
    await act(async () => { executeCommand('undo') })
    await waitFor(() => expect(usePartEditorStore.getState().features.some(f => f.id === 'ex1')).toBe(true))
  })

  // The mixed branch used to end on clearNormalSelection, which clears the
  // selection, the claims, the chip-owned mirror and the domain but not
  // hoveredConstraintEntityIds -- which the store's own deleteSelected wipe
  // clears. A mixed Delete therefore left constraint-tile hover pointing at
  // deleted geometry, and the two branches disagreed on the post-condition.
  it('wipes the hovered-constraint residue on a mixed Delete, exactly like a sketch-only one', async () => {
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

    // Mixed: a sketch entity plus a 3D feature target, with tile hover set.
    act(() => {
      useSketchEditorStore.setState({
        activeFeatureId: 'sk1',
        normalSelection: new Set(['entity:sk1:L1', '@ex1']),
        chipOwnedSelection: new Set(['@ex1']),
        hoveredConstraintEntityIds: new Set(['c_hover']),
      })
    })
    await act(async () => { executeCommand('delete_selected') })

    const afterMixed = useSketchEditorStore.getState()
    expect(afterMixed.normalSelection.size).toBe(0)
    expect(afterMixed.selectedPicks.size).toBe(0)
    expect(afterMixed.chipOwnedSelection.size).toBe(0)
    expect(afterMixed.selectionDomain).toBe('sketch_2d')
    expect(afterMixed.hoveredConstraintEntityIds.size).toBe(0)

    // And the sketch-only branch still lands on the identical post-condition.
    act(() => {
      useSketchEditorStore.setState({
        activeFeatureId: 'sk1',
        normalSelection: new Set(['entity:sk1:L2']),
        chipOwnedSelection: new Set(['entity:sk1:L2']),
        hoveredConstraintEntityIds: new Set(['c_hover2']),
      })
    })
    await act(async () => { executeCommand('delete_selected') })

    const afterSketchOnly = useSketchEditorStore.getState()
    expect(afterSketchOnly.normalSelection.size).toBe(0)
    expect(afterSketchOnly.selectedPicks.size).toBe(0)
    expect(afterSketchOnly.chipOwnedSelection.size).toBe(0)
    expect(afterSketchOnly.selectionDomain).toBe('sketch_2d')
    expect(afterSketchOnly.hoveredConstraintEntityIds.size).toBe(0)
  })
})
